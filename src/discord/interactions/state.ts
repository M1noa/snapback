// short-lived interaction state store (D4PLAN 9.3, 5.1).
//
// a selection payload too large for a customID is stored here and referenced by
// a short random id embedded in the customID. in-memory is the default path;
// the interaction_state table is what makes a multi-worker deployment correct.
// ttl is 15 minutes, swept by the scheduler, but the sweep is callable directly
// so tests never need a timer. the clock is injectable for the same reason.

import type { InteractionStateRow, JsonValue } from "../../db/types.ts";

export const STATE_TTL_MS = 15 * 60 * 1000; // D4PLAN 9.3

// short but not guessable: 12 base62 chars carry ~71 bits. the test asserts the
// shape (length + character class) rather than the randomness of the source.
export const STATE_ID_LENGTH = 12;
const STATE_ID_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

export function newStateId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(STATE_ID_LENGTH));
  let out = "";
  for (const byte of bytes) out += STATE_ID_ALPHABET[byte % STATE_ID_ALPHABET.length]!;
  return out;
}

export interface InteractionState {
  readonly id: string;
  readonly guildId: string;
  readonly userId: string;
  readonly surface: string;
  readonly payload: JsonValue;
  readonly createdAt: number; // epoch ms
  readonly expiresAt: number; // epoch ms
}

export interface StatePut {
  readonly guildId: string;
  readonly userId: string;
  readonly surface: string;
  readonly payload: JsonValue;
}

export interface StateStore {
  /** stores the payload and returns the short id for the customID. */
  put(input: StatePut): Promise<string>;
  /** null when the id is unknown or expired. an expired row is dropped. */
  get(id: string): Promise<InteractionState | null>;
  delete(id: string): Promise<void>;
  /** drops every expired entry; returns how many went. */
  sweep(): Promise<number>;
}

export interface StateStoreOptions {
  /** injectable clock in epoch ms. defaults to Date.now. */
  readonly now?: () => number;
}

function ageOf(options: StateStoreOptions | undefined): () => number {
  return options?.now ?? (() => Date.now());
}

// the in-memory path. complete and the default for a single-process deploy.
export class MemoryStateStore implements StateStore {
  readonly #items = new Map<string, InteractionState>();
  readonly #now: () => number;

  constructor(options: StateStoreOptions = {}) {
    this.#now = ageOf(options);
  }

  async put(input: StatePut): Promise<string> {
    const now = this.#now();
    let id = newStateId();
    while (this.#items.has(id)) id = newStateId(); // collisions are a formality, not a risk
    this.#items.set(id, { id, ...input, createdAt: now, expiresAt: now + STATE_TTL_MS });
    return id;
  }

  async get(id: string): Promise<InteractionState | null> {
    const item = this.#items.get(id);
    if (!item) return null;
    if (item.expiresAt <= this.#now()) {
      this.#items.delete(id);
      return null;
    }
    return item;
  }

  async delete(id: string): Promise<void> {
    this.#items.delete(id);
  }

  async sweep(): Promise<number> {
    const now = this.#now();
    let removed = 0;
    for (const [id, item] of this.#items) {
      if (item.expiresAt <= now) {
        this.#items.delete(id);
        removed++;
      }
    }
    return removed;
  }
}

// narrow db access this store needs. the db/-owning agent supplies a concrete
// implementation backed by the interaction_state table (D4PLAN 5.1); this file
// does not own the query module and does not write the SQL.
export interface StateTable {
  insert(row: InteractionStateRow): Promise<void>;
  select(stateId: string): Promise<InteractionStateRow | null>;
  remove(stateId: string): Promise<void>;
  /** delete every row with expires_at <= nowIso; returns the count. */
  removeExpired(nowIso: string): Promise<number>;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

// the table-backed path for multi-worker deploys. same ttl, same short ids.
export class TableStateStore implements StateStore {
  readonly #table: StateTable;
  readonly #now: () => number;

  constructor(table: StateTable, options: StateStoreOptions = {}) {
    this.#table = table;
    this.#now = ageOf(options);
  }

  async put(input: StatePut): Promise<string> {
    const now = this.#now();
    const id = newStateId();
    await this.#table.insert({
      state_id: id,
      guild_id: input.guildId,
      user_id: input.userId,
      surface: input.surface,
      payload_json: input.payload,
      created_at: iso(now),
      expires_at: iso(now + STATE_TTL_MS),
    });
    return id;
  }

  async get(id: string): Promise<InteractionState | null> {
    const row = await this.#table.select(id);
    if (!row) return null;
    const expiresAt = Date.parse(row.expires_at);
    if (expiresAt <= this.#now()) {
      await this.#table.remove(id);
      return null;
    }
    return {
      id: row.state_id,
      guildId: row.guild_id,
      userId: row.user_id,
      surface: row.surface,
      payload: row.payload_json,
      createdAt: Date.parse(row.created_at),
      expiresAt,
    };
  }

  async delete(id: string): Promise<void> {
    await this.#table.remove(id);
  }

  async sweep(): Promise<number> {
    return this.#table.removeExpired(iso(this.#now()));
  }
}
