// the boot path (D4PLAN 4, 18.4). one process: database, rest client, gateway,
// interaction router, and command registration, in that order, each awaited.
//
// this file composes; it owns no behaviour of its own. anything that needs a
// decision lives in the module it came from. a failure here stops the process,
// because a bot that started without its database is worse than one that did not
// start.

import { createDiagnosticsProbes, createStatusProbe } from "./boot/probes.ts";
import { env } from "./config/env.ts";
import { close as closeDatabase, getDatabase, migrate, SCHEMA_VERSION } from "./db/index.ts";
import { getAdmin } from "./db/queries/admins.ts";
import { DiscordClient } from "./discord/client.ts";
import { buildDefinitions, diagnosticsCommand, statusCommand } from "./discord/commands/index.ts";
import { createCommandsRest, syncCommands } from "./discord/commands/register.ts";
import type { SlashCommand } from "./discord/commands/types.ts";
import { DiscordApiError, formatDiscordError } from "./discord/errors.ts";
import { Gateway, installProcessErrorHandlers } from "./discord/gateway.ts";
import { createAuthorizer, createInteractionHandler } from "./discord/interactions/handlers.ts";
import { type CustomIdSpec, Router } from "./discord/interactions/router.ts";
import { resolveScope } from "./discord/registry.ts";
import { createLogger, type Logger } from "./lib/log.ts";

// every customID surface this build produces. the boot assertion below refuses to
// start when one has no handler (D4PLAN 9.3). it is empty until the first
// component ships, and grows with each surface, not with each button.
const CUSTOM_ID_SPECS: readonly CustomIdSpec[] = [];

const READY_TIMEOUT_MS = 30_000;

interface Manifest {
  version: string;
}

export interface Boot {
  readonly log: Logger;
  readonly startedAt: number;
  /** close the gateway, the database, and the log sink, in that order. */
  stop(): Promise<void>;
}

// the dependency version is read from the installed package: oceanic exports no
// version of its own, and a hardcoded string in a status line is a lie the moment
// the dependency is bumped.
async function dependencyVersion(specifier: string): Promise<string> {
  try {
    const entry = import.meta.resolve(specifier); // .../node_modules/<pkg>/dist/lib/index.js
    const manifest = new URL("../../../package.json", entry);
    const parsed = (await Bun.file(manifest).json()) as { version?: string };
    return parsed.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

// a token preflight through our own client. oceanic's gateway bootstrap fails
// with its own "failed to get gateway information" and no parsed body, which is
// exactly the kind of paraphrase non-negotiable 5 forbids; asking discord first
// means a bad token arrives as a DiscordApiError with discord's own words.
async function reachDiscord(client: DiscordClient, log: Logger): Promise<void> {
  try {
    await client.request<{ url: string; shards: number }>({ method: "GET", route: "/gateway/bot" });
  } catch (error) {
    if (!(error instanceof DiscordApiError)) throw error;
    const report = formatDiscordError(error);
    log.error(report.headline, {
      status: report.status,
      code: report.code,
      said: report.said,
      method: error.method,
      route: error.route,
      fix:
        error.status === 401
          ? "the token was rejected. regenerate it in the Developer Panel (Bot tab) and update DISCORD_TOKEN."
          : report.fix,
    });
    throw new Error(
      `discord rejected ${error.method} ${error.route} with ${error.status}: ${report.said}`,
    );
  }
}

async function waitForReady(gateway: Gateway, log: Logger): Promise<boolean> {
  const client = gateway.client;
  if (client.ready) return true;
  return await new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      client.off("ready", onReady);
      log.error("gateway did not reach ready in time", { timeoutMs: READY_TIMEOUT_MS });
      resolve(false);
    }, READY_TIMEOUT_MS);
    function onReady(): void {
      clearTimeout(timer);
      client.off("ready", onReady);
      resolve(true);
    }
    client.once("ready", onReady);
  });
}

export async function boot(): Promise<Boot> {
  const startedAt = Date.now();
  const log = createLogger({ level: env.app.logLevel });
  installProcessErrorHandlers(log);

  const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as Manifest;
  const oceanicVersion = await dependencyVersion("oceanic.js");

  // 1. database. migrations are idempotent, so this runs every boot.
  const db = await getDatabase();
  await migrate(db);
  log.info("database ready", { driver: db.kind, file: env.db.isPostgres ? null : env.db.file });

  // 2. rest. all discord traffic goes through this client (AGENTS.md rule 6).
  const client = new DiscordClient({ token: env.discord.token, log });

  const isGuildAdmin = async (userId: string, guildId: string): Promise<boolean> => {
    const row = await getAdmin(db, guildId, userId);
    return row !== null;
  };

  // 3. gateway. oceanic owns the connection (D4PLAN 2, 4).
  const gateway = new Gateway({ token: env.discord.token, log });

  // 4. interactions. the enqueue is deliberately left unwired: the default throws,
  // which surfaces as a failed interaction rather than a silently dropped job.
  const router = new Router({
    authorize: createAuthorizer({ ownerId: env.discord.ownerId, isGuildAdmin }),
  });

  // the probes read the same wiring the commands do: a selected handle, the live
  // gateway, the limiter, and the configured paths. nothing here opens anything.
  const probeDeps = {
    db: () => Promise.resolve(db),
    version: manifest.version,
    oceanicVersion,
    startedAt,
    schemaVersion: SCHEMA_VERSION,
    gateway: () => gateway.status(),
    rateLimitBuckets: () => client.limiter.snapshot().buckets,
    dbBytesPath: env.db.isPostgres ? null : env.db.file,
    dbDriver: db.kind,
    commit: null,
  };

  const commands: SlashCommand[] = [
    statusCommand(createStatusProbe(probeDeps)),
    diagnosticsCommand(
      createDiagnosticsProbes({
        ...probeDeps,
        intelFiles: { countryMmdb: env.intel.countryMmdb, asCsv: env.intel.asCsv },
        intelEnabled: env.intel.enabled,
        tokenStorage: env.privacy.tokenStorage,
        // resolved when the probe runs, by which time commands is filled in.
        commandCount: () => buildDefinitions(commands).length,
        handlerKeys: router.registeredKeys(),
      }),
    ),
  ];
  const definitions = buildDefinitions(commands);

  // 5. the boot assertions (D4PLAN 9.3). a produced id with no handler, or a
  // command group with no description, stops the boot rather than failing an
  // interaction later.
  router.assertComplete(CUSTOM_ID_SPECS);

  const onInteraction = createInteractionHandler({
    commands,
    router,
    ownerId: env.discord.ownerId,
    log,
    isGuildAdmin,
  });
  gateway.client.on("interactionCreate", onInteraction);

  // 6. connect, then register. registration needs the application id, which only
  // exists once the gateway has told us who we are.
  await reachDiscord(client, log);
  await gateway.connect();
  const ready = await waitForReady(gateway, log);

  if (ready) {
    const applicationId = gateway.client.user.id;
    await syncCommands(
      createCommandsRest(client, applicationId),
      definitions,
      resolveScope(env.discord.devGuildId),
      log,
    );
  }

  log.info("snapback is up", {
    version: manifest.version,
    oceanic: oceanicVersion,
    schema: SCHEMA_VERSION,
    shards: gateway.status().shards,
  });

  let stopped = false;
  return {
    log,
    startedAt,
    async stop() {
      if (stopped) return;
      stopped = true;
      // the gateway first, so no new interaction arrives while the rest closes.
      gateway.destroy();
      await closeDatabase();
      await log.flush();
    },
  };
}
