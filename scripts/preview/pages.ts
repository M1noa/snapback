// scripts/preview/pages.ts
//
// every page the bot can draw, built with the real page builders and invented
// data.
//
// the point is to look at the design without a server, a guild and a discord
// client. the data is made up; the layout is not.

import { DEFAULT_GUILD_SETTINGS, DEFAULT_WIZARD } from "../../src/config/defaults.ts";
import type { BackupRow, GuildBlacklistRow, VerifyRecordRow } from "../../src/db/types.ts";
import {
  infoPage as backupInfoPage,
  jobPage as backupJobPage,
  listPage as backupListPage,
  prunePage as backupPrunePage,
} from "../../src/discord/commands/backup/pages.ts";
import { PULL_LIMIT_SOURCES } from "../../src/discord/commands/pull/deps.ts";
import {
  configPage,
  countersPage,
  planPage as pullPlanPage,
  reportPage as pullReportPage,
  resetPage,
} from "../../src/discord/commands/pull/pages.ts";
import {
  clearPage,
  planPage,
  jobPage as restoreJobPage,
  selectionPage,
} from "../../src/discord/commands/restore/pages.ts";
import {
  blacklistPage,
  recordPage as userRecordPage,
} from "../../src/discord/commands/users/pages.ts";
import {
  deletePage,
  panelPage,
  recordPage,
  recordsPage,
  startPage,
  jobPage as verifyJobPage,
} from "../../src/discord/commands/verify/pages.ts";
import { confirmPage } from "../../src/setup/pages.ts";
import { backupStep } from "../../src/setup/steps/backup.ts";
import { privacyStep } from "../../src/setup/steps/privacy.ts";
import { restoreStep } from "../../src/setup/steps/restore.ts";

const GUILD = "123456789012345678";
const USER = "987654321098765432";
const BACKUP = "0190a000-0000-7000-8000-000000000001";
const WHEN = "2024-06-01T00:00:00.000Z";
const EXPIRES = Date.parse("2024-06-01T00:15:00.000Z");

export interface PreviewPage {
  readonly path: string;
  readonly title: string;
  readonly surface: string;
  readonly tree: unknown;
}

function backup(overrides: Partial<BackupRow> = {}): BackupRow {
  return {
    backup_id: BACKUP,
    guild_id: GUILD,
    label: "nightly before the migration",
    kind: "auto",
    guild_name: "the fixture guild",
    icon_url: null,
    banner_url: null,
    splash_url: null,
    discovery_splash_url: null,
    owner_user_id: USER,
    member_count: 312,
    message_count: 18_402,
    channel_count: 47,
    role_count: 19,
    size_bytes: 268_435_456,
    schema_version: 1,
    guild_settings_json: null,
    onboarding_json: null,
    welcome_screen_json: null,
    widget_json: null,
    afk_json: null,
    self_check_json: {
      ok: true,
      failures: [],
      skipped: [{ category: "bans", what: "the ban list", why: "50013 Missing Permissions" }],
    },
    created_at: WHEN,
    created_by: USER,
    ...overrides,
  };
}

function record(overrides: Partial<VerifyRecordRow> = {}): VerifyRecordRow {
  return {
    record_id: "0190a000-0000-7000-8000-0000000000d1",
    guild_id: GUILD,
    user_id: "223344556677889900",
    username: "someone",
    global_name: "Some One",
    discriminator: "0",
    avatar_url: null,
    email: "someone@example.com",
    email_verified: true,
    locale: "en-GB",
    mfa_enabled: false,
    premium_type: 0,
    flags: 0,
    connections_json: null,
    guilds_json: null,
    relationships_json: null,
    oauth_scopes_json: ["identify", "email", "guilds.join"],
    oauth_granted_at: WHEN,
    oauth_last_checked_at: WHEN,
    access_token_enc: "enc",
    refresh_token_enc: "enc",
    token_expires_at: null,
    token_status: "valid",
    first_ip_hash: "hash",
    first_ip_enc: null,
    last_ip_hash: "hash",
    last_ip_enc: null,
    ip_history_json: null,
    country_code: "gb",
    country_name: "United Kingdom",
    city: null,
    region: null,
    isp: "an example isp",
    asn: "64500",
    as_org: "an example network",
    ip_type: "residential",
    is_vpn: false,
    is_proxy: false,
    is_tor: false,
    intel_checked_at: null,
    fingerprint_json: null,
    referrer: null,
    user_agent: null,
    revoked_at: null,
    notes: null,
    ...overrides,
  } as VerifyRecordRow;
}

/** every page, in the order a person would meet them. */
export function buildPages(): PreviewPage[] {
  const pages: PreviewPage[] = [];
  const add = (path: string, title: string, surface: string, tree: unknown): void => {
    pages.push({ path, title, surface, tree });
  };

  // --- the web layer -------------------------------------------------------
  add("/web/", "the landing page", "web", {
    type: 17,
    accentColor: 0x5865f2,
    components: [
      { type: 10, content: "snapback verification" },
      { type: 10, content: "server: **the fixture guild**" },
      {
        type: 1,
        components: [
          { type: 2, label: "Verify", style: 5, url: "https://verify.example/?guild=1&start=1" },
        ],
      },
      {
        type: 10,
        content:
          "-# verification is how a server proves who is in it. it is optional, and it is revocable.",
      },
    ],
  });

  // --- /backup -------------------------------------------------------------
  add(
    "/backup/list",
    "the backup list",
    "backup",
    backupListPage({
      guildId: GUILD,
      rows: [
        backup(),
        backup({
          backup_id: "0190a000-0000-7000-8000-000000000002",
          label: "before the panel went up",
          kind: "manual",
          created_at: "2024-05-28T00:00:00.000Z",
        }),
        backup({
          backup_id: "0190a000-0000-7000-8000-000000000003",
          label: "the first one",
          kind: "pre_restore",
          created_at: "2024-05-01T00:00:00.000Z",
          self_check_json: {
            ok: false,
            failures: ["member 900 carries 1 role(s) that are not in this backup: 404"],
            skipped: [],
          },
        }),
      ],
      page: 1,
      total: 3,
      selectId: "sb:backup:1:list:select:",
      prevId: "sb:backup:1:list:page:1",
      nextId: "sb:backup:1:list:page:2",
      createId: "sb:backup:1:list:refresh:1",
    }),
  );

  add(
    "/backup/info",
    "one backup",
    "backup",
    backupInfoPage({
      guildId: GUILD,
      backup: backup(),
      contents: [
        "bans 12 · emojis 34 · stickers 3 · sounds 7 · automod rules 2 · scheduled events 1",
      ],
      deleteId: "sb:backup:1:info:delete:x",
      exportId: "sb:backup:1:info:export:x",
      listId: "sb:backup:1:list:page:1",
    }),
  );

  add(
    "/backup/job",
    "a capture in flight",
    "backup",
    backupJobPage({
      job: {
        id: "01a15134-882f-7614-9a4c-e79489e551d8",
        guild_id: GUILD,
        kind: "backup",
        status: "running",
        requested_by: USER,
        payload_json: null,
        progress_json: null,
        error_code: null,
        error_body: null,
        created_at: WHEN,
        started_at: WHEN,
        finished_at: null,
        attempts: 1,
      },
      guildId: GUILD,
      etaSeconds: 412,
      refreshId: "sb:backup:1:job:refresh:x",
      pauseId: "sb:backup:1:job:pause:x",
      cancelId: "sb:backup:1:job:cancel:x",
      infoId: null,
    }),
  );

  add(
    "/backup/prune",
    "the prune plan",
    "backup",
    backupPrunePage({
      guildId: GUILD,
      policy: {
        guild_id: GUILD,
        keep_days: 30,
        keep_count: 10,
        keep_kind_json: ["auto", "manual"],
        enabled: true,
      },
      removals: [
        { label: "the first one", reason: "older than 30 day(s)" },
        { label: "before the panel went up", reason: "past the newest 10" },
      ],
      keptCount: 4,
      confirmId: "sb:backup:1:prune:prune:",
      listId: "sb:backup:1:list:page:1",
      dryRun: true,
    }),
  );

  add(
    "/backup/delete",
    "the destructive page",
    "backup",
    confirmPage({
      guildId: GUILD,
      title: "delete this backup",
      what: "delete `0190a000` (nightly before the migration), its 18,402 message(s) and every file it wrote.",
      consequence:
        "this cannot be undone. the backup is gone from this server, and no restore can use it afterwards.",
      nonce: "a1b2c3d4e5f6",
      cancel: "sb:backup:1:info:delete:x",
      expiresAt: EXPIRES,
      buildId: (nonce) => `sb:backup:${GUILD}:del:confirm:${nonce}`,
    }),
  );

  // --- /restore ------------------------------------------------------------
  add(
    "/restore/selection",
    "what to restore",
    "restore",
    selectionPage({
      guildId: GUILD,
      backupLabel: "nightly `0190a000`",
      targetLabel: "the fixture guild",
      enabled: ["guild", "roles", "channels", "members", "messages"],
      messageCount: 18_402,
      selectId: "sb:restore:1:confirm:submit:",
      planId: "sb:restore:1:plan:plan:",
      submitId: "sb:restore:1:confirm:submit:",
      clearId: "sb:restore:1:clear:open:",
    }),
  );

  add(
    "/restore/plan",
    "the plan",
    "restore",
    planPage({
      guildId: GUILD,
      lines: [
        "**roles** create role (19)",
        "**channels** create channel (47)",
        "**messages** post message, up to 1000 per channel (18,402)",
      ],
      backId: "sb:restore:1:confirm:submit:",
      submitId: "sb:restore:1:confirm:submit:",
    }),
  );

  add(
    "/restore/clear",
    "clearing the target",
    "restore",
    clearPage({
      guildId: GUILD,
      targetName: "the fixture guild",
      nonce: "a1b2c3d4e5f6",
      expiresAt: EXPIRES,
      cancelId: "sb:restore:1:confirm:submit:",
    }),
  );

  add(
    "/restore/job",
    "a restore in flight",
    "restore",
    restoreJobPage({
      guildId: GUILD,
      lines: [
        "job `01a15134` is restoring into the fixture guild.",
        "the phases run in order, and each one is checkpointed.",
      ],
      state: "info",
      refreshId: "sb:restore:1:job:refresh:x",
      cancelId: "sb:restore:1:job:cancel:x",
    }),
  );

  // --- /verify -------------------------------------------------------------
  add(
    "/verify/panel",
    "the panel builder",
    "verify",
    panelPage({
      guildId: GUILD,
      channelId: "444555666777888999",
      title: "server verification",
      description: "this server uses a verification check to keep its member list honest.",
      scopes: ["identify", "email", "guilds.join"],
      buttonLabel: "Verify",
      restrictedWithoutAcknowledgement: false,
      channelSelectId: "sb:verify:1:panel:open:",
      submitId: "sb:verify:1:panel:submit:",
      scopeGroupId: "sb:verify:1:panel:submit:",
      detailsId: "sb:verify:1:panel:details:",
      backId: "sb:verify:1:records:open:",
    }),
  );

  add(
    "/verify/start",
    "starting the flow",
    "verify",
    startPage({
      guildId: GUILD,
      url: "https://discord.com/oauth2/authorize?client_id=1&state=a1b2c3",
    }),
  );

  add(
    "/verify/records",
    "the records",
    "verify",
    recordsPage({
      guildId: GUILD,
      rows: [
        {
          userId: "223344556677889900",
          username: "someone",
          scopes: ["identify", "email"],
          lastChecked: WHEN,
          tokenStatus: "valid",
        },
        {
          userId: "223344556677889901",
          username: "another",
          scopes: ["identify"],
          lastChecked: null,
          tokenStatus: "stale",
        },
        {
          userId: "223344556677889902",
          username: "revoked",
          scopes: ["identify", "email"],
          lastChecked: "2024-05-01T00:00:00.000Z",
          tokenStatus: "revoked",
        },
      ],
      page: 1,
      pages: 2,
      selectId: "sb:verify:1:records:select:",
      prevId: "sb:verify:1:records:open:1",
      nextId: "sb:verify:1:records:open:2",
      refreshId: "sb:verify:1:records:refresh:",
      deleteId: "sb:verify:1:records:delete:",
    }),
  );

  add(
    "/verify/record",
    "one record",
    "verify",
    recordPage({
      guildId: GUILD,
      record: {
        userId: "223344556677889900",
        username: "someone",
        globalName: "Some One",
        email: "someone@example.com",
        emailVerified: true,
        scopes: ["identify", "email", "guilds.join"],
        countryName: "United Kingdom",
        isp: "an example isp",
        asOrg: "an example network",
        ipType: "residential",
        guilds: ["the fixture guild"],
        connections: ["a steam account"],
        relationshipsCaptured: false,
        fingerprint: "captured",
        tokenStatus: "valid",
        lastChecked: WHEN,
        events: [
          { at: WHEN, kind: "oauth", detail: "the scopes were granted" },
          { at: "2024-06-02T00:00:00.000Z", kind: "refreshed_ok", detail: "" },
        ],
      },
      revokeId: "sb:verify:1:record:revoke:x",
      deleteId: "sb:verify:1:record:delete:x",
      backId: "sb:verify:1:records:open:",
    }),
  );

  add(
    "/verify/delete",
    "erasing a record",
    "verify",
    deletePage({
      guildId: GUILD,
      userId: "223344556677889900",
      username: "someone",
      scopes: [
        { key: "record", what: "the row: the identity, the scopes, the network" },
        { key: "ip", what: "the address, in whatever form it was stored" },
        { key: "token", what: "the access and refresh tokens" },
      ],
      submitId: "sb:verify:1:record:delete:x",
      backId: "sb:verify:1:records:open:",
    }),
  );

  add(
    "/verify/job",
    "a refresh in flight",
    "verify",
    verifyJobPage({
      guildId: GUILD,
      lines: ["job `01a15134` is refreshing the tokens that are due."],
      state: "info",
      refreshId: "sb:verify:1:job:refresh:x",
    }),
  );

  // --- /users and /pull ----------------------------------------------------
  add(
    "/users/record",
    "what the server holds about a person",
    "users",
    userRecordPage({
      guildId: GUILD,
      record: record(),
      records: [record()],
      membership: { state: "member", nickname: "someone", joinedAt: "2024-01-01T00:00:00.000Z" },
      counters: {
        attempts: 4,
        successes: 3,
        failures: 1,
        restricted: false,
        restrictedReason: null,
        cooldownUntil: null,
      },
      ipStorage: "hash",
      selectId: "sb:users:1:records:select:",
      exportId: "sb:users:1:records:export:",
    }),
  );

  add(
    "/users/blacklist",
    "the blacklist",
    "users",
    blacklistPage({
      guildId: GUILD,
      entries: [
        {
          guild_id: GUILD,
          kind: "user_id",
          value: "223344556677889900",
          added_by: USER,
          added_at: WHEN,
        },
        {
          guild_id: GUILD,
          kind: "asn",
          value: "64500",
          added_by: USER,
          added_at: "2024-06-02T00:00:00.000Z",
        },
      ] as GuildBlacklistRow[],
      note: null,
      refreshId: "sb:users:1:blacklist:refresh:",
    }),
  );

  add(
    "/pull/plan",
    "who would be added",
    "pull",
    pullPlanPage({
      guildId: GUILD,
      lines: [
        { userId: "223344556677889900", username: "someone", skippedReason: null },
        {
          userId: "223344556677889901",
          username: "another",
          skippedReason: "the account has used its 100 attempt(s) for today",
        },
        {
          userId: "223344556677889902",
          username: "revoked",
          skippedReason: "20013 the account is restricted",
        },
      ],
      trying: 1,
      skipping: 2,
      confirmId: "sb:pull:1:plan:confirm:",
      backId: "sb:pull:1:counters:open:",
      expiresAt: EXPIRES,
    }),
  );

  add(
    "/pull/report",
    "what the pull did",
    "pull",
    pullReportPage({
      guildId: GUILD,
      lines: [
        {
          userId: "223344556677889900",
          username: "someone",
          attempts: 1,
          successes: 1,
          failures: 0,
          restricted: false,
          restrictedReason: null,
          cooldownUntil: null,
          lastOutcome: "added",
          lastSaid: null,
        },
        {
          userId: "223344556677889901",
          username: "another",
          attempts: 0,
          successes: 0,
          failures: 0,
          restricted: false,
          restrictedReason: null,
          cooldownUntil: null,
          lastOutcome: "skipped",
          lastSaid: "the account has used its 100 attempt(s) for today",
        },
      ],
      totals: { attempts: 1, successes: 1, failures: 0, restricted: 0 },
      jobId: "01a15134-882f-7614-9a4c-e79489e551d8",
      jobStatus: "succeeded",
      jobError: null,
      etaSeconds: null,
      planId: "sb:pull:1:plan:open:",
      refreshId: "sb:pull:1:counters:refresh:",
      cancelId: null,
      pauseId: null,
      paused: false,
    }),
  );

  add(
    "/pull/counters",
    "the counters",
    "pull",
    countersPage({
      guildId: GUILD,
      lines: [
        {
          userId: "223344556677889900",
          username: "someone",
          attempts: 4,
          successes: 3,
          failures: 1,
          restricted: false,
          restrictedReason: null,
          cooldownUntil: null,
          earlierDays: 2,
        },
        {
          userId: "223344556677889902",
          username: "revoked",
          attempts: 100,
          successes: 0,
          failures: 100,
          restricted: true,
          restrictedReason: "20013 the account is restricted",
          cooldownUntil: null,
          earlierDays: 0,
        },
      ],
      totals: { attempts: 104, successes: 3, failures: 101, restricted: 1 },
      limits: {
        dailyLimit: 100,
        failureCooldownMinutes: 60,
        restrictedHours: 24,
      },
      refreshId: "sb:pull:1:counters:refresh:",
      configId: "sb:pull:1:counters:config:",
      backId: "sb:pull:1:plan:open:",
    }),
  );

  add(
    "/pull/reset",
    "resetting a counter",
    "pull",
    resetPage({
      guildId: GUILD,
      userId: "223344556677889900",
      username: "someone",
      attempts: 4,
      successes: 3,
      failures: 1,
      restricted: false,
      restrictedReason: null,
      cooldownUntil: null,
      done: false,
      confirmId: "sb:pull:1:counters:reset:x",
      backId: "sb:pull:1:counters:open:",
    }),
  );

  add(
    "/pull/config",
    "the limits in force",
    "pull",
    configPage({
      guildId: GUILD,
      limits: { dailyLimit: 100, failureCooldownMinutes: 60, restrictedHours: 24 },
      sources: PULL_LIMIT_SOURCES,
      backId: "sb:pull:1:counters:open:",
    }),
  );

  // --- the setup wizard ----------------------------------------------------
  // the steps read two things off the deps, and nothing else.
  const stepCtx = {
    guildId: GUILD,
    userId: USER,
    settings: DEFAULT_GUILD_SETTINGS,
    wizard: DEFAULT_WIZARD,
    deps: {
      privacy: { ipStorage: "hash", tokenStorage: true },
    } as never,
  };
  add("/setup/backup", "the setup step: backup defaults", "setup", backupStep.render(stepCtx));
  add("/setup/privacy", "the setup step: privacy", "setup", privacyStep.render(stepCtx));
  add("/setup/restore", "the setup step: restore defaults", "setup", restoreStep.render(stepCtx));

  return pages;
}
