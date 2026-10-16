import { describe, expect, test } from "bun:test";

// boots the real entry point in a child process with a hand-built environment.
// this is the only way to cover the exit-on-missing-key path, and it is the
// phase 1 acceptance check: a fresh checkout starts or says exactly why not.
const ENTRY = new URL("../src/index.ts", import.meta.url).pathname;

async function boot(
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const child = Bun.spawn({
    cmd: [process.execPath, ENTRY],
    env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { code: await child.exited, out, err };
}

const MINIMAL = {
  DISCORD_TOKEN: "test-token",
  DISCORD_OWNER_ID: "100000000000000001",
  PUBLIC_BASE_URL: "https://snapback.example",
  IP_STORAGE: "hash",
  IP_HASH_PEPPER: "pepper",
};

describe("boot", () => {
  test("starts and prints the resolved config", async () => {
    const { code, out } = await boot(MINIMAL);

    expect(code).toBe(0);
    expect(out).toContain("snapback 0.0.0");
    expect(out).toContain("./data/snapback.duckdb");
    expect(out).toContain("https://snapback.example on :8080");
    expect(out).toContain("ip        hash");
    expect(out).toContain("tokens    storage unavailable");
    expect(out).toContain("100000000000000001");
  });

  test("refuses to start without a token and lists what is missing", async () => {
    const { code, err } = await boot({ PUBLIC_BASE_URL: "https://snapback.example" });

    expect(code).toBe(1);
    expect(err).toContain("cannot start");
    expect(err).toContain("1. DISCORD_TOKEN is not set");
    expect(err).toContain("2. DISCORD_OWNER_ID is not set");
  });

  test("reports a warning on stderr without failing", async () => {
    const { code, err } = await boot({ ...MINIMAL, IP_STORAGE: "plaintext" });

    expect(code).toBe(0);
    expect(err).toContain("personal data");
  });
});
