// the boot path (D4PLAN 4, 18.4). one process: database, rest client, gateway,
// interaction router, and command registration, in that order, each awaited.
//
// this file composes; it owns no behaviour of its own. anything that needs a
// decision lives in the module it came from. a failure here stops the process,
// because a bot that started without its database is worse than one that did not
// start.

import { createDiagnosticsProbes, createStatusProbe } from "./boot/probes.ts";
import { DEFAULT_GUILD_SETTINGS } from "./config/defaults.ts";
import { env } from "./config/env.ts";
import { close as closeDatabase, getDatabase, migrate, SCHEMA_VERSION } from "./db/index.ts";
import { getAdmin } from "./db/queries/admins.ts";
import { insertAudit } from "./db/queries/audit.ts";
import { countBackupMessagesByBackup } from "./db/queries/backup-messages.ts";
import { getBackup, listBackupsByGuild } from "./db/queries/backups.ts";
import {
  getGuild,
  getGuildSettings,
  listActiveGuilds,
  syncGuildIdentity,
} from "./db/queries/guilds.ts";
import { getRetentionPolicy } from "./db/queries/retention.ts";
import { listPanelsForGuild } from "./db/queries/verify-panels.ts";
import {
  clearRecordIp,
  clearRecordTokens,
  deleteRecord,
  getRecord,
  listRecords,
} from "./db/queries/verify-records.ts";
import { canSurface } from "./discord/access.ts";
import { DiscordClient } from "./discord/client.ts";
import { BACKUP_SPECS, type BackupDeps } from "./discord/commands/backup/deps.ts";
import { registerBackupHandlers } from "./discord/commands/backup/handlers.ts";
import { backupCommands } from "./discord/commands/backup/index.ts";
import { buildDefinitions, diagnosticsCommand, statusCommand } from "./discord/commands/index.ts";
import { PULL_SPECS, type PullDeps } from "./discord/commands/pull/deps.ts";
import { registerPullHandlers } from "./discord/commands/pull/handlers.ts";
import { pullCommands } from "./discord/commands/pull/index.ts";
import { createCommandsRest, syncCommands } from "./discord/commands/register.ts";
import { RESTORE_SPECS, type RestoreDeps } from "./discord/commands/restore/deps.ts";
import { registerRestoreHandlers } from "./discord/commands/restore/handlers.ts";
import { restoreCommands } from "./discord/commands/restore/index.ts";
import { setupCommands } from "./discord/commands/setup/index.ts";
import type { SlashCommand } from "./discord/commands/types.ts";
import { USERS_SPECS, type UsersDeps } from "./discord/commands/users/deps.ts";
import { registerUsersHandlers } from "./discord/commands/users/handlers.ts";
import { usersCommands } from "./discord/commands/users/index.ts";
import { VERIFY_SPECS, type VerifyDeps } from "./discord/commands/verify/deps.ts";
import { registerVerifyHandlers } from "./discord/commands/verify/handlers.ts";
import { verifyCommands } from "./discord/commands/verify/index.ts";
import { DiscordApiError, formatDiscordError } from "./discord/errors.ts";
import { Gateway, installProcessErrorHandlers } from "./discord/gateway.ts";
import { createAuthorizer, createInteractionHandler } from "./discord/interactions/handlers.ts";
import { type CustomIdSpec, Router } from "./discord/interactions/router.ts";
import { MemoryStateStore } from "./discord/interactions/state.ts";
import { resolveScope } from "./discord/registry.ts";
import { createLogger, type Logger } from "./lib/log.ts";
import { createBackupJobHandler } from "./services/backup/job.ts";
import { createExportJobHandler } from "./services/export/job.ts";
import { JobRunner } from "./services/jobs/runner.ts";
import { pullAccounts } from "./services/pull/index.ts";
import { createRestoreJobHandler } from "./services/restore/job.ts";
import { buildPlan } from "./services/restore/plan.ts";
import { DEFAULT_RETENTION } from "./services/retention/index.ts";
import { buildAuthorizeUrl, exchangeCode, refreshAccessToken } from "./services/verify/oauth.ts";
import { createPanel, postPanel } from "./services/verify/panel.ts";
import { addRecordEvent, upsertRecord } from "./services/verify/records.ts";
import { createTokenStore } from "./services/verify/token-store.ts";
import { registerSetupHandlers, SETUP_SPECS } from "./setup/handlers.ts";
import { createSetupDeps } from "./setup/wiring.ts";
import { assetRoute } from "./web/assets.ts";
import { displayName } from "./web/display-name.ts";
import { callbackRoute } from "./web/routes/callback.ts";
import { healthRoute } from "./web/routes/health.ts";
import { homeRoute } from "./web/routes/home.ts";
import { createServer } from "./web/server.ts";

// every customID surface this build produces. the boot assertion below refuses to
// start when one has no handler (D4PLAN 9.3). the /setup wizard is the first
// surface, so this is its whole vocabulary (SETUP_SPECS); it grows with each new
// surface, not with each button.
const CUSTOM_ID_SPECS: readonly CustomIdSpec[] = [
  ...SETUP_SPECS,
  ...BACKUP_SPECS,
  ...RESTORE_SPECS,
  ...VERIFY_SPECS,
  ...USERS_SPECS,
  ...PULL_SPECS,
];

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

/** the accent the operator typed, as the number the row holds. a colour that is
 *  not a hex number is left out, and the guild's own colour stands. */
function hexToNumber(hex: string): number | undefined {
  const trimmed = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(trimmed)) return undefined;
  return Number.parseInt(trimmed, 16);
}

// a hash with no segment is no asset: discord omits the field rather than
// sending an empty one. same shape the capture path builds its urls with.
function iconUrl(guildId: string, hash: string | null): string | null {
  if (hash === null || hash === "") return null;
  const ext = hash.startsWith("a_") ? "gif" : "png";
  return `https://cdn.discordapp.com/icons/${guildId}/${hash}.${ext}`;
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

  // the admin row carries a grant per capability, and the surface says which
  // capability is being asked for: reading records is not the same grant as
  // running a backup (D4PLAN 19.1, and the table in 5.1).
  const isGuildAdmin = async (
    userId: string,
    guildId: string,
    surface: string,
  ): Promise<boolean> => {
    const row = await getAdmin(db, guildId, userId);
    if (row === null) return false;
    return canSurface(row, surface);
  };

  // 3. gateway. oceanic owns the connection (D4PLAN 2, 4).
  const gateway = new Gateway({ token: env.discord.token, log });

  // what discord says a guild is, kept fresh where the web pages read it: a
  // server rename lands on the landing page without a capture. no settings and
  // no job rows are touched, and a guild create re-opens the row after a kick.
  const syncIdentity = (member: {
    id: string;
    name: string;
    icon: string | null;
    ownerID: string | null;
  }): void => {
    void syncGuildIdentity(db, {
      guildId: member.id,
      name: member.name,
      iconUrl: iconUrl(member.id, member.icon),
      ownerUserId: member.ownerID,
      at: new Date().toISOString(),
    }).catch((error: unknown) =>
      log.error("guild identity sync failed", {
        guild_id: member.id,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
  };
  gateway.client.on("guildCreate", syncIdentity);
  gateway.client.on("guildUpdate", syncIdentity);

  // 4. interactions. the enqueue is deliberately left unwired: the default throws,
  // which surfaces as a failed interaction rather than a silently dropped job.
  const router = new Router({
    authorize: createAuthorizer({ ownerId: env.discord.ownerId, isGuildAdmin }),
  });

  // the /setup surface. built once here and used twice below: to register the
  // component handlers and to build the /setup command. every input it needs (the
  // database, the rest client, the gateway) exists by this point, and registration
  // runs before assertComplete so a control with no handler stops the boot.
  const setupDeps = createSetupDeps({
    db,
    client,
    gateway,
    log,
    ownerId: env.discord.ownerId,
  });
  registerSetupHandlers(router, setupDeps);

  // the job runner. one per kind, serialised per guild, resumable from the
  // progress rows (D4PLAN 4.1). it is started here so a job left running by the
  // last boot is picked up.
  const jobs = new JobRunner({
    db,
    log,
    maxConcurrentJobs: env.limits.maxConcurrentJobs,
  });
  jobs.register(
    "backup",
    createBackupJobHandler({
      db,
      client,
      log,
      settings: async (guildId) => (await getGuildSettings(db, guildId)) ?? DEFAULT_GUILD_SETTINGS,
      limits: {
        maxMessagesPerChannel: env.limits.maxMessagesPerChannel,
        maxMessagesTotal: env.limits.maxMessagesTotal,
      },
      backupDir: env.storage.backupDir,
      maxAssetBytes: env.storage.maxAssetBytes,
    }),
  );
  jobs.register("export", createExportJobHandler({ db, log, exportDir: env.storage.exportDir }));
  jobs.register(
    "restore",
    createRestoreJobHandler({ db, client, log, backupDir: env.storage.backupDir }),
  );
  await jobs.start();

  // the /backup surface. the same access check the router runs for every other
  // control, and the settings and lookups it reads.
  const backupDeps: BackupDeps = {
    db,
    client,
    log,
    jobs,
    now: () => Date.now(),
    retention: async (guildId) => (await getRetentionPolicy(db, guildId)) ?? DEFAULT_RETENTION,
    settings: async (guildId) => (await getGuildSettings(db, guildId)) ?? DEFAULT_GUILD_SETTINGS,
    state: new MemoryStateStore(),
    limits: {
      maxMessagesPerChannel: env.limits.maxMessagesPerChannel,
      maxMessagesTotal: env.limits.maxMessagesTotal,
    },
    backupDir: env.storage.backupDir,
    exportDir: env.storage.exportDir,
    authorize: (userId, guildId) => isGuildAdmin(userId, guildId, "backup"),
    audit: async (input) => {
      await insertAudit(db, {
        id: Bun.randomUUIDv7(),
        guild_id: input.guildId,
        actor_user_id: input.actorUserId,
        action: input.action,
        target: input.target,
        detail_json: input.detail ?? null,
        created_at: new Date().toISOString(),
      });
    },
    lookup: async (guildId, backupId) => {
      const row = await getBackup(db, backupId);
      // scoped to the guild: an id from another server is not reachable here.
      return row !== null && row.guild_id === guildId ? row : null;
    },
    lookupAll: async (guildId) => await listBackupsByGuild(db, guildId),
  };
  registerBackupHandlers(router, backupDeps);

  // the /restore surface. the same access check, the same state store, and the
  // plan builder the dry run reads.
  const restoreDeps: RestoreDeps = {
    db,
    log,
    jobs,
    now: () => Date.now(),
    settings: async (guildId) => (await getGuildSettings(db, guildId)) ?? DEFAULT_GUILD_SETTINGS,
    state: new MemoryStateStore(),
    backups: async (guildId) => await listBackupsByGuild(db, guildId),
    guilds: async () =>
      (await listActiveGuilds(db)).map((row) => ({ id: row.guild_id, name: row.name })),
    lookup: async (guildId, backupId) => {
      const row = await getBackup(db, backupId);
      return row !== null && row.guild_id === guildId ? row : null;
    },
    authorize: (userId, guildId) => isGuildAdmin(userId, guildId, "restore"),
    audit: async (input) => {
      await insertAudit(db, {
        id: Bun.randomUUIDv7(),
        guild_id: input.guildId,
        actor_user_id: input.actorUserId,
        action: input.action,
        target: input.target,
        detail_json: input.detail ?? null,
        created_at: new Date().toISOString(),
      });
    },
    plan: async (backupId, options) => await buildPlan(db, backupId, options),
    messageCount: async (backupId) => await countBackupMessagesByBackup(db, backupId),
  };
  registerRestoreHandlers(router, restoreDeps);

  // the /verify surface. the panel is the opt-in server backup, and the records
  // are what it produced.
  const verifyDeps: VerifyDeps = {
    db,
    log,
    jobs,
    now: () => Date.now(),
    settings: async (guildId) => (await getGuildSettings(db, guildId)) ?? DEFAULT_GUILD_SETTINGS,
    state: new MemoryStateStore(),
    records: async (guildId, limit) => await listRecords(db, guildId, limit),
    record: async (guildId, userId) => await getRecord(db, guildId, userId),
    panel: async (guildId) => (await listPanelsForGuild(db, guildId))[0] ?? null,
    savePanel: async (input) => {
      const panel = await createPanel(
        { client, db, log },
        {
          guildId: input.guildId,
          channelId: input.channelId,
          title: input.title,
          description: input.description,
          buttonLabel: input.buttonLabel,
          buttonStyle: 1,
          scopes: input.scopes,
          redirectUri: `${env.web.publicBaseUrl}/callback`,
          enabled: true,
          color: hexToNumber(input.color),
          thumbnailUrl: input.thumbnailUrl,
        },
      );
      await postPanel({ client, db, log }, panel);
      return panel;
    },
    deleteRecord: async (input) => {
      if (input.scope === "token") {
        await clearRecordTokens(db, input.guildId, input.userId);
        return { deleted: true, what: "the tokens" };
      }
      if (input.scope === "ip") {
        await clearRecordIp(db, input.guildId, input.userId);
        return { deleted: true, what: "the address" };
      }
      if (input.scope === "all") {
        await clearRecordTokens(db, input.guildId, input.userId);
        await clearRecordIp(db, input.guildId, input.userId);
      }
      await deleteRecord(db, input.guildId, input.userId);
      return { deleted: true, what: input.scope === "all" ? "everything" : "the record" };
    },
    authorizeUrl: async (guildId, panelId) => {
      if (env.oauth.clientSecret === "") return null;
      const panels = await listPanelsForGuild(db, guildId);
      const panel = panels.find((row) => row.panel_id === panelId);
      if (panel === undefined) return null;
      const built = await buildAuthorizeUrl(oauthDeps, {
        guildId,
        userId: "panel",
        scopes: panel.scopes_json,
      });
      return built.url;
    },
    refresh: async () => ({ checked: 0, refreshed: 0, failed: 0 }),
    ownerId: env.discord.ownerId,
    authorize: (userId, guildId) => isGuildAdmin(userId, guildId, "verify"),
    audit: async (input) => {
      await insertAudit(db, {
        id: Bun.randomUUIDv7(),
        guild_id: input.guildId,
        actor_user_id: input.actorUserId,
        action: input.action,
        target: input.target,
        detail_json: input.detail ?? null,
        created_at: new Date().toISOString(),
      });
    },
  };
  registerVerifyHandlers(router, verifyDeps);

  // the /users group: what this server holds about a person, and the export.
  const usersDeps: UsersDeps = {
    db,
    log,
    jobs,
    now: () => Date.now(),
    ipStorage: env.privacy.ipStorage,
    exportDir: env.storage.exportDir,
    authorize: (userId, guildId) => isGuildAdmin(userId, guildId, "users"),
    audit: async (input) => {
      await insertAudit(db, {
        id: Bun.randomUUIDv7(),
        guild_id: input.guildId,
        actor_user_id: input.actorUserId,
        action: input.action,
        target: input.target,
        detail_json: input.detail ?? null,
        created_at: new Date().toISOString(),
      });
    },
    records: async (guildId, limit) => await listRecords(db, guildId, limit),
    record: async (guildId, userId) => await getRecord(db, guildId, userId),
    member: async (guildId, userId) => {
      // the membership comes from the bot's own cache, so "unknown" is a real
      // answer and not a guess.
      const member = gateway.client.guilds.get(guildId)?.members.get(userId);
      if (member === undefined) {
        return { state: "unknown", nickname: null, joinedAt: null };
      }
      return {
        state: "member",
        nickname: member.nick,
        joinedAt: member.joinedAt === null ? null : member.joinedAt.toISOString(),
      };
    },
  };
  registerUsersHandlers(router, usersDeps);

  // a stale access token is refreshed once. the new one comes back out of the
  // store, so it never reaches a log line or a page.
  const pullRefresh = async (userId: string): Promise<string | null> => {
    const refreshed = await refreshAccessToken(oauthDeps, userId);
    if (!refreshed) return null;
    const stored = await tokenStore.get(userId);
    return stored?.accessToken ?? null;
  };

  // the /pull group. a member is added only with a token they granted.
  const pullDeps: PullDeps = {
    db,
    log,
    jobs,
    now: () => Date.now(),
    state: new MemoryStateStore(),
    limits: {
      dailyLimit: env.limits.pullDailyLimitPerAccount,
      failureCooldownMinutes: env.limits.pullFailureCooldownMinutes,
      restrictedHours: env.limits.pullCooldownHours,
    },
    authorize: (userId, guildId) => isGuildAdmin(userId, guildId, "pull"),
    audit: async (input) => {
      await insertAudit(db, {
        id: Bun.randomUUIDv7(),
        guild_id: input.guildId,
        actor_user_id: input.actorUserId,
        action: input.action,
        target: input.target,
        detail_json: input.detail ?? null,
        created_at: new Date().toISOString(),
      });
    },
    accounts: async (guildId) => {
      const rows = await listRecords(db, guildId, 1000);
      return rows.map((row) => ({
        userId: row.user_id,
        username: row.username,
        tokenStatus: row.token_status,
        scopes: row.oauth_scopes_json ?? [],
        hasToken: row.access_token_enc !== null,
      }));
    },
    token: async (userId) => {
      // the token never comes back out of the store in a form a page could show.
      const stored = await tokenStore.get(userId);
      return stored?.accessToken ?? null;
    },
    refresh: pullRefresh,
    pull: async (input) =>
      await pullAccounts(
        {
          client,
          db,
          log,
          limits: {
            dailyLimit: env.limits.pullDailyLimitPerAccount,
            failureCooldownMinutes: env.limits.pullFailureCooldownMinutes,
            restrictedHours: env.limits.pullCooldownHours,
          },
          refresh: pullRefresh,
        },
        input,
      ),
  };
  registerPullHandlers(router, pullDeps);

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
    ...setupCommands(setupDeps),
    ...backupCommands(backupDeps),
    ...restoreCommands(restoreDeps),
    ...verifyCommands(verifyDeps),
    ...usersCommands(usersDeps),
    ...pullCommands(pullDeps),
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
    isGuildAdmin: (userId, guildId) => isGuildAdmin(userId, guildId, "command"),
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

  // the web layer. four routes, one process. the verify flow needs the oauth
  // client secret, and without it the routes still answer and the flow refuses.
  const tokenStore = createTokenStore({
    db,
    log,
    encryptionKey: env.privacy.encryptionKey,
  });
  const oauthDeps = {
    client,
    db,
    log,
    publicBaseUrl: env.web.publicBaseUrl,
    // the client id is the application id: the bot's own application.
    clientId: gateway.client.application?.id ?? env.discord.ownerId,
    clientSecret: env.oauth.clientSecret,
    tokens: tokenStore,
    clientIp: null,
  };
  const web = createServer({
    db,
    log,
    ip: {
      behindCloudflareTunnel: env.web.behindCloudflareTunnel,
      trustedProxyDepth: env.web.trustedProxyDepth,
      storage: env.privacy.ipStorage,
      hashPepper: env.privacy.ipHashPepper,
      encryptionKey: env.privacy.encryptionKey,
    },
    routes: {
      home: homeRoute({
        db,
        authorizeUrl: async (guildId) => {
          if (env.oauth.clientSecret === "") return null;
          const built = await buildAuthorizeUrl(oauthDeps, {
            guildId,
            userId: "web",
            scopes: ["identify", "email", "guilds.join"],
          });
          return built.url;
        },
      }),
      callback: callbackRoute({
        db,
        log,
        ip: {
          behindCloudflareTunnel: env.web.behindCloudflareTunnel,
          trustedProxyDepth: env.web.trustedProxyDepth,
          storage: env.privacy.ipStorage,
          hashPepper: env.privacy.ipHashPepper,
          encryptionKey: env.privacy.encryptionKey,
        },
        exchange: async ({ code, state }) => {
          const result = await exchangeCode(oauthDeps, { code, state });
          if (result === null) return null;
          // an empty guild id is the web flow's own convention for "no server"
          // (the record below is kept under ""); only a real id names a page.
          const { guildId } = result;
          const named = guildId !== null && guildId !== "";
          const row = named ? await getGuild(db, guildId) : null;
          const settings = named ? await getGuildSettings(db, guildId) : null;
          return {
            userId: result.userId,
            guildId,
            guildName: displayName(settings, row),
            username: result.username,
            email: result.email,
            scopes: result.scopes,
            connections: result.connections,
            guilds: result.guilds,
          };
        },
        record: async ({
          userId,
          ip,
          fingerprint,
          username,
          email,
          scopes,
          connections,
          guilds,
        }) => {
          // the record is per (user, guild). a guild id of "" means the
          // verification was not linked to a server, and the row is kept under
          // the empty guild so a second verification does not erase the first.
          await upsertRecord(
            { db, log, ipStorage: env.privacy.ipStorage },
            {
              userId,
              guildId: "",
              username: username ?? "",
              globalName: null,
              discriminator: null,
              avatarUrl: null,
              email: email ?? null,
              emailVerified: null,
              locale: null,
              mfaEnabled: null,
              premiumType: null,
              flags: null,
              connections: connections ?? [],
              guilds: guilds ?? [],
              relationships: [],
              oauthScopes: scopes ?? [],
              grantedAt: new Date().toISOString(),
              firstIpStored: ip.stored,
              lastIpStored: ip.stored,
            },
          );
          await addRecordEvent({ db, log }, { userId, kind: "oauth", detail: { fingerprint } });
        },
      }),
      assets: assetRoute(),
      health: healthRoute({
        db,
        log,
        version: manifest.version,
        startedAt,
        schemaVersion: SCHEMA_VERSION,
        gateway: () => (gateway.client.ready ? "ready" : "not ready"),
        queueDepth: () => 0,
      }),
    },
    port: env.web.port,
  });

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
      web.stop();
      await jobs.stop();
      await closeDatabase();
      await log.flush();
    },
  };
}
