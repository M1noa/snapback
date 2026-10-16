// slash command registration + diff, and the owner-or-admin gate (D4PLAN 8).
//
// commands register at the dev guild when DISCORD_DEV_GUILD_ID is set (instant)
// and globally otherwise (up to an hour). default_member_permissions is
// deliberately absent: commands stay visible and authorisation happens in code.
// a deny is plain data for the caller to render as an ephemeral container, never
// a stack trace. the REST call is injected so this file does not import
// discord/client.ts or discord/errors.ts.

// discord application command option types we emit.
export const OPTION_TYPE = {
  subCommand: 1,
  subCommandGroup: 2,
  string: 3,
  integer: 4,
  boolean: 5,
  user: 6,
  channel: 7,
  role: 8,
  mentionable: 9,
  number: 10,
  attachment: 11,
} as const;

export interface CommandOption {
  readonly name: string;
  readonly description: string;
  readonly type: number;
  readonly required?: boolean;
  readonly options?: readonly CommandOption[];
}

// default_member_permissions is intentionally not a field here (D4PLAN 8).
export interface CommandDefinition {
  readonly name: string;
  readonly description: string;
  readonly options?: readonly CommandOption[];
}

// the subset of a registered command the diff reads.
export interface RegisteredCommand {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly options?: readonly CommandOption[];
}

export interface RegistrationScope {
  readonly kind: "guild" | "global";
  readonly guildId?: string;
}

/** dev guild set means guild registration, else global (D4PLAN 8). */
export function resolveScope(devGuildId: string | undefined): RegistrationScope {
  return devGuildId ? { kind: "guild", guildId: devGuildId } : { kind: "global" };
}

/** the REST calls this file needs, typed narrowly. discord/client.ts supplies
 *  the implementation; this module never imports it. */
export interface CommandsRest {
  list(scope: RegistrationScope): Promise<readonly RegisteredCommand[]>;
  put(
    scope: RegistrationScope,
    commands: readonly CommandDefinition[],
  ): Promise<readonly RegisteredCommand[]>;
}

export async function registerCommands(
  rest: CommandsRest,
  definitions: readonly CommandDefinition[],
  scope: RegistrationScope,
): Promise<readonly RegisteredCommand[]> {
  return rest.put(scope, definitions);
}

export interface CommandChange {
  readonly name: string;
  /** one line per field that differs, e.g. "options.channel.required: false -> true". */
  readonly fields: readonly string[];
}

export interface CommandDiff {
  readonly added: readonly string[]; // defined, not live
  readonly removed: readonly string[]; // live, not defined
  readonly changed: readonly CommandChange[];
  readonly unchanged: readonly string[];
}

/** a diff, not a blind overwrite, so a rename or a changed option is visible. */
export function diffCommands(
  defined: readonly CommandDefinition[],
  registered: readonly RegisteredCommand[],
): CommandDiff {
  const registeredByName = new Map(registered.map((command) => [command.name, command]));
  const definedNames = new Set(defined.map((command) => command.name));

  const added: string[] = [];
  const removed: string[] = [];
  const changed: CommandChange[] = [];
  const unchanged: string[] = [];

  for (const command of defined) {
    const live = registeredByName.get(command.name);
    if (!live) {
      added.push(command.name);
      continue;
    }
    const fields = compareCommand(command, live);
    if (fields.length > 0) changed.push({ name: command.name, fields });
    else unchanged.push(command.name);
  }
  for (const command of registered) {
    if (!definedNames.has(command.name)) removed.push(command.name);
  }

  return { added, removed, changed, unchanged };
}

export function isSynced(diff: CommandDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0;
}

function compareCommand(defined: CommandDefinition, live: RegisteredCommand): string[] {
  const fields: string[] = [];
  if (defined.description !== live.description) {
    fields.push(`description: ${defined.description} -> ${live.description}`);
  }
  fields.push(...compareOptions("options", defined.options ?? [], live.options ?? []));
  return fields;
}

// matched by name, not index, so a reordered option is not reported as changed.
function compareOptions(
  path: string,
  defined: readonly CommandOption[],
  live: readonly CommandOption[],
): string[] {
  const fields: string[] = [];
  const liveByName = new Map(live.map((option) => [option.name, option]));
  const definedNames = new Set(defined.map((option) => option.name));

  for (const option of defined) {
    const current = liveByName.get(option.name);
    if (!current) {
      fields.push(`${path}.${option.name}: missing in live`);
      continue;
    }
    if (option.type !== current.type) {
      fields.push(`${path}.${option.name}.type: ${option.type} -> ${current.type}`);
    }
    if (option.description !== current.description) {
      fields.push(
        `${path}.${option.name}.description: ${option.description} -> ${current.description}`,
      );
    }
    const required = option.required ?? false;
    const liveRequired = current.required ?? false;
    if (required !== liveRequired) {
      fields.push(`${path}.${option.name}.required: ${required} -> ${liveRequired}`);
    }
    fields.push(
      ...compareOptions(`${path}.${option.name}`, option.options ?? [], current.options ?? []),
    );
  }
  for (const option of live) {
    if (!definedNames.has(option.name)) {
      fields.push(`${path}.${option.name}: removed from definition`);
    }
  }
  return fields;
}

export interface AccessInput {
  readonly userId: string;
  readonly guildId: string;
  readonly ownerId: string;
  /** db-backed: is this user a Snapback admin for the guild (guild_admins)? */
  readonly isGuildAdmin: (userId: string, guildId: string) => Promise<boolean> | boolean;
}

// plain data. the caller renders it as an ephemeral container; this file builds
// no components.
export interface DenialData {
  readonly title: string;
  readonly body: string;
  readonly needs: string;
  readonly ephemeral: true;
  readonly status: "danger" | "warning";
}

export type AccessResult =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly denial: DenialData };

/** owner-or-guild-admin, re-checked on every interaction (non-negotiable 8). */
export async function checkAccess(input: AccessInput): Promise<AccessResult> {
  if (input.userId === input.ownerId) return { kind: "allow" };
  if (await input.isGuildAdmin(input.userId, input.guildId)) return { kind: "allow" };
  return { kind: "deny", denial: denialFor(input.userId) };
}

function denialFor(userId: string): DenialData {
  return {
    title: "not permitted",
    body: `you (<@${userId}>) are not a Snapback admin for this server.`,
    needs: "ask the server owner or a current Snapback admin to add you with /setup admins.",
    ephemeral: true,
    status: "danger",
  };
}
