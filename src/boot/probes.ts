// the numbers /snapback status and /snapback diagnostics read (D4PLAN 8, 7.6).
//
// everything here is a probe: a function of the running process, injected into
// the commands so the commands stay testable and a failing read degrades one line
// instead of taking the page down.

import { statSync } from "node:fs";
import { listActiveGuilds } from "../db/queries/guilds.ts";
import { listResumableJobs } from "../db/queries/jobs.ts";
import type { Database } from "../db/types.ts";
import type { Probe, ProbeResult } from "../discord/commands/system/diagnostics.ts";
import type { StatusProbe, StatusSnapshot } from "../discord/commands/system/status.ts";
import { GATEWAY_INTENTS } from "../discord/gateway.ts";

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** byte size of the duckdb file, or null when there is no file to measure. */
function fileSize(path: string | null): number | null {
  if (path === null) return null;
  try {
    return statSync(path).size;
  } catch {
    return null;
  }
}

export interface ProbeDeps {
  /** select, never a connected handle: the probe runs on every status call. */
  readonly db: () => Promise<Database>;
  readonly version: string;
  readonly oceanicVersion: string;
  readonly startedAt: number;
  readonly schemaVersion: number;
  readonly gateway: () => { ready: boolean; ping: number | null };
  readonly rateLimitBuckets: () => number;
  /** null when the driver stores nothing on local disk (postgres). */
  readonly dbBytesPath: string | null;
  readonly dbDriver: string;
  readonly commit: string | null;
}

export function createStatusProbe(deps: ProbeDeps): StatusProbe {
  return async (): Promise<StatusSnapshot> => {
    const db = await deps.db();
    const [jobs, guilds] = [await listResumableJobs(db), await listActiveGuilds(db)];
    const gateway = deps.gateway();

    return {
      version: deps.version,
      commit: deps.commit,
      oceanicVersion: deps.oceanicVersion,
      schemaVersion: deps.schemaVersion,
      startedAt: deps.startedAt,
      gatewayReady: gateway.ready,
      gatewayLatencyMs: gateway.ping,
      jobDepth: jobs.filter((job) => job.status === "queued").length,
      jobRunning: jobs.filter((job) => job.status === "running").length,
      dbDriver: deps.dbDriver,
      dbBytes: fileSize(deps.dbBytesPath),
      trackedGuilds: guilds.length,
      rateLimitBuckets: deps.rateLimitBuckets(),
    };
  };
}

export interface DiagnosticsDeps extends ProbeDeps {
  /** whether the mmdb and as-metadata files are on disk. */
  readonly intelFiles: {
    readonly countryMmdb: string;
    readonly ip2asnTsv: string;
    readonly asMetadataJson: string;
    readonly torList: string;
  };
  readonly intelEnabled: boolean;
  readonly tokenStorage: boolean;
  readonly commandCount: () => number;
  readonly handlerKeys: readonly string[];
}

function ok(name: string, detail: string): ProbeResult {
  return { name, state: "ok", detail };
}

function warn(name: string, detail: string): ProbeResult {
  return { name, state: "warn", detail };
}

function fail(name: string, detail: string): ProbeResult {
  return { name, state: "fail", detail };
}

/** reaches the database and reads the recorded schema version. */
async function databaseProbe(deps: DiagnosticsDeps): Promise<ProbeResult> {
  try {
    const db = await deps.db();
    const rows = await db.query<{ value: string | null }>("SELECT value FROM meta WHERE key = ?", [
      "schema_version",
    ]);
    const found = rows[0]?.value ?? null;
    if (found === null)
      return warn("database", `${deps.dbDriver} reachable, no schema version row`);
    return ok("database", `${deps.dbDriver} reachable, schema v${found}`);
  } catch (error) {
    return fail("database", messageOf(error));
  }
}

function gatewayProbe(deps: DiagnosticsDeps): ProbeResult {
  const gateway = deps.gateway();
  if (!gateway.ready) return fail("gateway", "not connected to discord");
  return ok("gateway", `connected, ${gateway.ping ?? 0} ms ping`);
}

function intentsProbe(): ProbeResult {
  // 4014 is always the privileged-intent toggle (D4PLAN 18.4), so name the intent
  // that must be on rather than the count alone.
  const privileged = GATEWAY_INTENTS.includes("GUILD_MEMBERS");
  return ok(
    "intents",
    `${GATEWAY_INTENTS.length} requested, GUILD_MEMBERS ${privileged ? "on" : "OFF"}`,
  );
}

function intelProbe(deps: DiagnosticsDeps): ProbeResult {
  if (!deps.intelEnabled) return ok("geo data", "intel disabled, geo skipped by configuration");
  const missing: string[] = [];
  for (const path of Object.values(deps.intelFiles)) {
    try {
      statSync(path);
    } catch {
      missing.push(path);
    }
  }
  if (missing.length > 0) {
    // a missing data file skips geo, it never stops a boot (D4PLAN 9).
    return warn("geo data", `missing ${missing.join(", ")}; geo lookups are skipped`);
  }
  return ok("geo data", "country database, ip to asn table, as metadata and tor exits present");
}

function storageProbe(deps: DiagnosticsDeps): ProbeResult {
  if (!deps.tokenStorage) {
    return warn("token storage", "ENCRYPTION_KEY is not set, so /pull and token refresh are off");
  }
  return ok("token storage", "encryption key present");
}

function surfaceProbe(deps: DiagnosticsDeps): ProbeResult {
  const keys = deps.handlerKeys.length === 0 ? "none yet" : deps.handlerKeys.join(", ");
  return ok("surfaces", `${deps.commandCount()} command(s) defined, components: ${keys}`);
}

/** the probe set /snapback diagnostics runs. order is the report order. */
export function createDiagnosticsProbes(deps: DiagnosticsDeps): Probe[] {
  return [
    { name: "database", run: () => databaseProbe(deps) },
    { name: "gateway", run: () => gatewayProbe(deps) },
    { name: "intents", run: () => intentsProbe() },
    { name: "geo data", run: () => intelProbe(deps) },
    { name: "token storage", run: () => storageProbe(deps) },
    { name: "surfaces", run: () => surfaceProbe(deps) },
  ];
}
