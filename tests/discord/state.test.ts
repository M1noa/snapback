import { describe, expect, test } from "bun:test";
import type { InteractionStateRow } from "../../src/db/types.ts";
import {
  MemoryStateStore,
  STATE_ID_LENGTH,
  STATE_TTL_MS,
  type StatePut,
  type StateTable,
  TableStateStore,
} from "../../src/discord/interactions/state.ts";

const GUILD = "100000000000000001";
const USER = "200000000000000002";

const input: StatePut = {
  guildId: GUILD,
  userId: USER,
  surface: "backup",
  payload: { page: 3, selected: ["100000000000000003"] },
};

describe("MemoryStateStore", () => {
  test("stores and retrieves a payload", async () => {
    const store = new MemoryStateStore();
    const id = await store.put(input);
    const state = await store.get(id);

    expect(state).not.toBeNull();
    expect(state?.payload).toEqual(input.payload);
    expect(state?.guildId).toBe(GUILD);
    expect(state?.userId).toBe(USER);
    expect(state?.surface).toBe("backup");
    expect(state?.expiresAt).toBe((state?.createdAt ?? 0) + STATE_TTL_MS);
  });

  test("an unknown id misses", async () => {
    const store = new MemoryStateStore();
    expect(await store.get("doesnotexist")).toBeNull();
  });

  test("an id misses once the injected clock is past the ttl", async () => {
    let now = 1_000_000;
    const store = new MemoryStateStore({ now: () => now });

    const first = await store.put(input);
    now += STATE_TTL_MS; // exactly at expiresAt is already stale
    expect(await store.get(first)).toBeNull();

    const second = await store.put(input);
    now += STATE_TTL_MS + 1; // one ms past
    expect(await store.get(second)).toBeNull();
  });

  test("sweep drops expired entries without a timer", async () => {
    let now = 0;
    const store = new MemoryStateStore({ now: () => now });
    const stale = await store.put(input);
    now += STATE_TTL_MS + 1;
    const fresh = await store.put(input);

    expect(await store.sweep()).toBe(1);
    expect(await store.get(stale)).toBeNull();
    expect(await store.get(fresh)).not.toBeNull();
  });

  test("the id is short and not guessable by shape", async () => {
    const store = new MemoryStateStore();
    const id = await store.put(input);

    expect(STATE_TTL_MS).toBe(15 * 60 * 1000);
    expect(id).toHaveLength(STATE_ID_LENGTH);
    expect(id).toMatch(/^[A-Za-z0-9]+$/);

    const second = await store.put(input);
    expect(second).not.toBe(id);
  });
});

// a stand-in for the injected table access the db/ owner will supply.
function fakeTable(): { table: StateTable; rows: Map<string, InteractionStateRow> } {
  const rows = new Map<string, InteractionStateRow>();
  const table: StateTable = {
    insert: async (row) => {
      rows.set(row.state_id, row);
    },
    select: async (stateId) => rows.get(stateId) ?? null,
    remove: async (stateId) => {
      rows.delete(stateId);
    },
    removeExpired: async (nowIso) => {
      let removed = 0;
      for (const [key, row] of rows) {
        if (row.expires_at <= nowIso) {
          rows.delete(key);
          removed++;
        }
      }
      return removed;
    },
  };
  return { table, rows };
}

describe("TableStateStore", () => {
  test("round-trips through the injected table and honours the ttl", async () => {
    let now = 500_000;
    const { table, rows } = fakeTable();
    const store = new TableStateStore(table, { now: () => now });

    const id = await store.put(input);
    expect(rows.size).toBe(1);
    expect((await store.get(id))?.payload).toEqual(input.payload);

    now += STATE_TTL_MS + 1;
    expect(await store.get(id)).toBeNull();
    expect(rows.size).toBe(0); // a stale read drops the row
  });

  test("sweep delegates to the table", async () => {
    let now = 0;
    const { table } = fakeTable();
    const store = new TableStateStore(table, { now: () => now });
    await store.put(input);

    now += STATE_TTL_MS + 1;
    expect(await store.sweep()).toBe(1);
  });
});
