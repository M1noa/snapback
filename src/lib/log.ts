// the logger (D4PLAN 3, 16). destinations: a rotating file under data/logs/ and
// stderr, plus an optional log-channel sink the caller injects. there is no
// console.log in src/ (AGENTS.md checklist); this file and stderr are the only
// output paths.
//
// every line, message and field alike, goes through redact.ts before it is
// written or handed to the sink (AGENTS.md rule 10: no token, email, or full ip
// reaches a log). nothing here may throw into the caller: a log that fails, a
// file that is unwritable, or a sink that rejects is swallowed (D4PLAN 16).

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { redactText, redactValue } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const LEVELS = Object.keys(RANK) as LogLevel[];

function isLevel(value: unknown): value is LogLevel {
  return typeof value === "string" && (LEVELS as string[]).includes(value);
}

/** free-form structured fields attached to a line. redacted before use. */
export type LogFields = Record<string, unknown>;

/** one redacted event, as written to the file, stderr, and the channel sink. */
export interface LogRecord {
  time: string;
  level: LogLevel;
  msg: string;
  fields: LogFields;
}

// the discord-facing send function the caller injects. the logger never imports
// the discord client (another module owns it); the caller wires this in. it may
// return a promise, and a rejection here is swallowed and logged once.
export type LogChannelSink = (record: LogRecord) => void | Promise<void>;

export interface LoggerOptions {
  /** minimum level to emit. default: env.app.logLevel, resolved lazily. */
  level?: LogLevel;
  /** directory for the rotating file. default: data/logs. null disables the file. */
  dir?: string | null;
  /** rotate once the active file passes this many bytes. default 5 MiB. */
  maxBytes?: number;
  /** how many rotated files to keep beside the active one. default 5. */
  maxFiles?: number;
  /** injectable sink for the log channel. */
  channelSink?: LogChannelSink;
}

export interface Logger {
  readonly level: LogLevel;
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  error(msg: string, fields?: LogFields): void;
  /** settle any in-flight sink deliveries. */
  flush(): Promise<void>;
}

const DEFAULT_DIR = "data/logs";
const FILE_NAME = "snapback.log";
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 5;

// the env value is a default, not a dependency: env.ts parses the process
// environment and exits on a missing key, so importing it at module load would
// make every test that touches this file exit. it is required lazily, only when
// a logger is built without an explicit level, and a failure falls back to info.
function envLogLevel(): LogLevel {
  try {
    const require = createRequire(import.meta.url);
    const mod = require("../config/env.ts") as { env?: { app?: { logLevel?: unknown } } };
    const level = mod?.env?.app?.logLevel;
    if (isLevel(level)) return level;
  } catch {
    // no env (tests, or a partial environment): fall back silently.
  }
  return "info";
}

export function createLogger(options: LoggerOptions = {}): Logger {
  // resolved lazily: an explicit level wins and env is never touched. tests
  // always pass a level, so env.ts is never imported on their path.
  let resolvedLevel: LogLevel | undefined = options.level;
  function level(): LogLevel {
    if (resolvedLevel === undefined) resolvedLevel = envLogLevel();
    return resolvedLevel;
  }

  const explicitDir = "dir" in options ? options.dir : undefined;
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  const maxFiles = Math.max(1, options.maxFiles ?? DEFAULT_MAX_FILES);
  const sink = options.channelSink;

  // the file path is derived on first write, so constructing a logger touches
  // no filesystem and creates no directory the caller did not ask for.
  let dir: string | null | undefined = explicitDir;
  let file = "";
  function resolveFile(): string | null {
    if (dir === undefined) dir = join(process.cwd(), DEFAULT_DIR);
    if (dir === null) return null;
    if (file === "") file = join(dir, FILE_NAME);
    return file;
  }

  let size = -1;
  function currentSize(path: string): number {
    if (size >= 0) return size;
    try {
      size = existsSync(path) ? statSync(path).size : 0;
    } catch {
      size = 0;
    }
    return size;
  }

  function rotate(path: string): void {
    try {
      rmSync(`${path}.${maxFiles}`, { force: true });
      for (let index = maxFiles - 1; index >= 1; index -= 1) {
        const from = `${path}.${index}`;
        if (existsSync(from)) renameSync(from, `${path}.${index + 1}`);
      }
      if (existsSync(path)) renameSync(path, `${path}.1`);
      size = 0;
    } catch {
      // rotation failure must not lose the line or throw; just keep appending.
    }
  }

  function writeFile(line: string): void {
    const path = resolveFile();
    if (path === null) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      currentSize(path);
      appendFileSync(path, line, "utf8");
      size += Buffer.byteLength(line, "utf8");
      if (size >= maxBytes) rotate(path);
    } catch {
      // an unwritable file never breaks the action that logged (AGENTS.md 16).
    }
  }

  function writeStderr(line: string): void {
    try {
      process.stderr.write(line);
    } catch {
      // a closed stderr is not the caller's problem.
    }
  }

  const pending = new Set<Promise<void>>();
  let sinkWarned = false;

  function onSinkError(error: unknown): void {
    if (sinkWarned) return; // D4PLAN 16: warn once, then stay quiet.
    sinkWarned = true;
    const line = format({
      time: new Date().toISOString(),
      level: "warn",
      msg: "log channel sink failed, notifications suppressed until retested",
      fields: { error: redactValue(error) },
    });
    writeFile(line);
    writeStderr(line);
  }

  function dispatch(record: LogRecord): void {
    if (sink === undefined) return;
    try {
      const result = sink(record);
      if (result && typeof (result as Promise<void>).then === "function") {
        const promise = (result as Promise<void>)
          .catch(onSinkError)
          .finally(() => pending.delete(promise));
        pending.add(promise);
      }
    } catch (error) {
      onSinkError(error);
    }
  }

  function format(record: LogRecord): string {
    return `${JSON.stringify(record)}\n`;
  }

  function emit(at: LogLevel, msg: string, fields: LogFields = {}): void {
    if (RANK[at] < RANK[level()]) return;
    const record: LogRecord = {
      time: new Date().toISOString(),
      level: at,
      msg: redactText(msg),
      fields: redactValue(fields) as LogFields,
    };
    const line = format(record);
    writeFile(line);
    writeStderr(line);
    dispatch(record);
  }

  return {
    get level() {
      return level();
    },
    debug: (msg, fields) => emit("debug", msg, fields),
    info: (msg, fields) => emit("info", msg, fields),
    warn: (msg, fields) => emit("warn", msg, fields),
    error: (msg, fields) => emit("error", msg, fields),
    async flush() {
      await Promise.allSettled([...pending]);
    },
  };
}
