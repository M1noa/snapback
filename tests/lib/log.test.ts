import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLogger, type LogRecord } from "../../src/lib/log.ts";

// real-shaped fixtures, not toys.
const TOKEN = "MTk4NjIyNDgzNDcxOTI1MjQ4.Cl2FMQ.ZnCjm1XVW7vRze4b7Cq4se7kKWs";
const EMAIL = "someone@example.com";
const IPV4 = "203.0.113.7";

// a temp dir per test, never the repo's data/. read back from the rotating file.
function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "snapback-log-"));
}

const dirs: string[] = [];
function trackedDir(): string {
  const dir = freshDir();
  dirs.push(dir);
  return dir;
}

function readLog(dir: string): string {
  return readFileSync(join(dir, "snapback.log"), "utf8");
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("redaction at the log boundary", () => {
  test("a token, an email, and a full ip are absent while the message survives", () => {
    const dir = trackedDir();
    const logger = createLogger({ level: "debug", dir });

    logger.info(`auth failed for ${EMAIL} from ${IPV4} with ${TOKEN}`, {
      token: TOKEN,
      email: EMAIL,
    });

    const out = readLog(dir);
    expect(out).not.toContain(TOKEN);
    expect(out).not.toContain(EMAIL);
    expect(out).not.toContain(IPV4);
    expect(out).toContain("sk_***");
    expect(out).toContain("<email>");
    expect(out).toContain("<ip>");
    // the message around the secrets is not thrown away.
    expect(out).toContain("auth failed for");
  });
});

describe("level filtering", () => {
  test("a warn logger drops debug and info, keeps warn and error", () => {
    const dir = trackedDir();
    const logger = createLogger({ level: "warn", dir });

    logger.verbose("the verbose line");
    logger.debug("the debug line");
    logger.info("the info line");
    logger.warn("the warn line");
    logger.error("the error line");

    const out = readLog(dir);
    expect(out).not.toContain("the verbose line");
    expect(out).not.toContain("the debug line");
    expect(out).not.toContain("the info line");
    expect(out).toContain("the warn line");
    expect(out).toContain("the error line");
  });

  test("verbose is below debug, so a debug logger still drops it", () => {
    const dir = trackedDir();
    const logger = createLogger({ level: "debug", dir });

    logger.verbose("the verbose line");
    logger.debug("the debug line");

    const out = readLog(dir);
    expect(out).not.toContain("the verbose line");
    expect(out).toContain("the debug line");
  });
});

describe("the log-channel sink", () => {
  test("a sink that throws does not propagate to the caller", () => {
    const logger = createLogger({
      level: "info",
      dir: null,
      channelSink: () => {
        throw new Error("channel is gone");
      },
    });

    expect(() => logger.info("still fine")).not.toThrow();
  });

  test("a sink that rejects is swallowed and does not surface", async () => {
    const seen: LogRecord[] = [];
    const logger = createLogger({
      level: "info",
      dir: null,
      channelSink: (record) => {
        if (record.msg === "blows up") return Promise.reject(new Error("nope"));
        seen.push(record);
        return; // the other path returns a promise, so this one says so too
      },
    });

    logger.info("delivered");
    logger.info("blows up");
    await logger.flush();

    expect(seen.map((r) => r.msg)).toEqual(["delivered"]);
  });
});
