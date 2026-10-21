import { describe, expect, test } from "bun:test";
import { type EnvSource, parseEnv, readProcessEnv } from "../../src/config/parse-env.ts";

// parseEnv takes a lookup, not the process environment, so every case here is a
// plain map. values are pre-normalized: absence is undefined, never "".
function source(values: Record<string, string | undefined>): EnvSource {
  return (key) => values[key];
}

const MINIMAL = {
  DISCORD_TOKEN: "token",
  DISCORD_OWNER_ID: "100000000000000001",
  DISCORD_CLIENT_ID: "100000000000000002",
  PUBLIC_BASE_URL: "https://snapback.example",
  OAUTH_CLIENT_SECRET: "secret",
};

function ok(values: Record<string, string | undefined>) {
  const result = parseEnv(source(values));
  if (!result.ok) throw new Error(`expected ok, got ${result.problems.join("; ")}`);
  return result;
}

function fail(values: Record<string, string | undefined>) {
  const result = parseEnv(source(values));
  if (result.ok) throw new Error("expected failure");
  return result.problems;
}

describe("parseEnv", () => {
  test("accepts the minimum and applies defaults", () => {
    const { env } = ok(MINIMAL);

    expect(env.discord.token).toBe("token");
    expect(env.db.isPostgres).toBe(false);
    expect(env.db.file).toBe("./data/snapback.duckdb");
    expect(env.web.port).toBe(8080);
    expect(env.privacy.ipStorage).toBe("plaintext");
    expect(env.limits.maxMessagesTotal).toBe(10_000);
    expect(env.app.automationEnabled).toBe(true);
  });

  test("names every missing key at once", () => {
    const problems = fail({});

    expect(problems).toHaveLength(5);
    expect(problems.join("\n")).toContain("DISCORD_TOKEN");
    expect(problems.join("\n")).toContain("DISCORD_OWNER_ID");
    expect(problems.join("\n")).toContain("DISCORD_CLIENT_ID");
    expect(problems.join("\n")).toContain("PUBLIC_BASE_URL");
    expect(problems.join("\n")).toContain("OAUTH_CLIENT_SECRET");
  });

  test("trims a trailing slash off the base url", () => {
    const { env } = ok({ ...MINIMAL, PUBLIC_BASE_URL: "https://snapback.example/" });
    expect(env.web.publicBaseUrl).toBe("https://snapback.example");
  });

  test("takes a postgres url as the database", () => {
    const { env } = ok({ ...MINIMAL, DATABASE_URL: "postgres://u:p@host:5432/db" });
    expect(env.db.isPostgres).toBe(true);
    expect(env.db.url).toBe("postgres://u:p@host:5432/db");
  });

  test("blank optional keys stay unset", () => {
    const { env } = ok({ ...MINIMAL, DISCORD_DEV_GUILD_ID: "" });
    expect(env.discord.devGuildId).toBe("");
  });

  test("the client id and secret land in env", () => {
    const { env } = ok(MINIMAL);
    expect(env.discord.clientId).toBe("100000000000000002");
    expect(env.oauth.clientSecret).toBe("secret");
  });

  describe("privacy", () => {
    test("hash requires a pepper", () => {
      const problems = fail({ ...MINIMAL, IP_STORAGE: "hash" });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("IP_HASH_PEPPER");
    });

    test("encrypted requires a key", () => {
      const problems = fail({ ...MINIMAL, IP_STORAGE: "encrypted" });
      expect(problems).toHaveLength(1);
      expect(problems[0]).toContain("ENCRYPTION_KEY");
    });

    test("a key that is not 32 bytes is rejected", () => {
      const problems = fail({ ...MINIMAL, ENCRYPTION_KEY: Buffer.alloc(8).toString("base64") });
      expect(problems[0]).toContain("must decode to 32 bytes");
      expect(problems[0]).toContain("got 8");
    });

    test("a 32 byte key enables token storage", () => {
      const key = Buffer.alloc(32, 7).toString("base64");
      const { env, warnings } = ok({ ...MINIMAL, ENCRYPTION_KEY: key });
      expect(env.privacy.tokenStorage).toBe(true);
      expect(warnings.map((w) => w.key)).not.toContain("ENCRYPTION_KEY");
    });

    test("plaintext warns at boot", () => {
      const { warnings } = ok(MINIMAL);
      const warning = warnings.find((w) => w.key === "IP_STORAGE");
      expect(warning?.text).toContain("personal data");
    });

    test("no key warns that pull is unavailable", () => {
      const { warnings } = ok(MINIMAL);
      expect(warnings.find((w) => w.key === "ENCRYPTION_KEY")?.text).toContain("unavailable");
    });
  });

  describe("limits", () => {
    test("clamps the total ceiling down and says so", () => {
      const { env, warnings } = ok({ ...MINIMAL, MAX_MESSAGES_TOTAL: "999999" });
      expect(env.limits.maxMessagesTotal).toBe(10_000);
      expect(warnings.find((w) => w.key === "MAX_MESSAGES_TOTAL")?.text).toContain(
        "clamped to 10000",
      );
    });

    test("clamps the per channel ceiling to 10000", () => {
      const { env } = ok({ ...MINIMAL, MAX_MESSAGES_PER_CHANNEL: "50000" });
      expect(env.limits.maxMessagesPerChannel).toBe(10_000);
    });

    test("floors the pull limit at 100", () => {
      const { env } = ok({ ...MINIMAL, PULL_DAILY_LIMIT_PER_ACCOUNT: "5" });
      expect(env.limits.pullDailyLimitPerAccount).toBe(100);
    });

    test("keeps the fallback for a value that is not a number", () => {
      const { env, warnings } = ok({ ...MINIMAL, MAX_CONCURRENT_JOBS: "two" });
      expect(env.limits.maxConcurrentJobs).toBe(2);
      expect(warnings.find((w) => w.key === "MAX_CONCURRENT_JOBS")?.text).toContain(
        "expected an integer",
      );
    });

    test("rejects a port outside the range", () => {
      const { env } = ok({ ...MINIMAL, PORT: "99999" });
      expect(env.web.port).toBe(65_535);
    });
  });

  describe("fallbacks", () => {
    test("an unknown enum value keeps the default and warns", () => {
      const { env, warnings } = ok({ ...MINIMAL, IP_STORAGE: "rot13" });
      expect(env.privacy.ipStorage).toBe("plaintext");
      expect(warnings.find((w) => w.key === "IP_STORAGE")?.text).toContain("expected one of");
    });

    test("a non boolean keeps the default and warns", () => {
      const { env, warnings } = ok({ ...MINIMAL, AUTOMATION_ENABLED: "yes" });
      expect(env.app.automationEnabled).toBe(true);
      expect(warnings.find((w) => w.key === "AUTOMATION_ENABLED")?.text).toContain(
        "expected true or false",
      );
    });

    test("log level is one of four", () => {
      expect(ok({ ...MINIMAL, LOG_LEVEL: "debug" }).env.app.logLevel).toBe("debug");
      expect(ok({ ...MINIMAL, LOG_LEVEL: "LOUD" }).env.app.logLevel).toBe("info");
    });
  });
});

describe("readProcessEnv", () => {
  test("treats a blank value as unset and trims the rest", () => {
    Bun.env.SNAPBACK_TEST_BLANK = "   ";
    Bun.env.SNAPBACK_TEST_PADDED = "  value  ";

    expect(readProcessEnv("SNAPBACK_TEST_BLANK")).toBeUndefined();
    expect(readProcessEnv("SNAPBACK_TEST_PADDED")).toBe("value");
    expect(readProcessEnv("SNAPBACK_TEST_ABSENT")).toBeUndefined();

    Bun.env.SNAPBACK_TEST_BLANK = undefined;
    Bun.env.SNAPBACK_TEST_PADDED = undefined;
  });
});
