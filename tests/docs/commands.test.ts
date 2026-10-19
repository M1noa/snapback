// tests/docs/commands.test.ts
// the command surface and docs/commands.md are one contract: a command that
// ships has to be documented, and a command the doc names has to exist.
//
// the list is built the way src/boot.ts builds it, so a group the boot stops
// registering is a group the doc has to stop naming, and a group the boot
// starts registering is a group the doc has to start naming.

import { beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { BackupDeps } from "../../src/discord/commands/backup/deps.ts";
import { backupCommands } from "../../src/discord/commands/backup/index.ts";
import { buildDefinitions } from "../../src/discord/commands/index.ts";
import type { RestoreDeps } from "../../src/discord/commands/restore/deps.ts";
import { restoreCommands } from "../../src/discord/commands/restore/index.ts";
import { setupCommands } from "../../src/discord/commands/setup/index.ts";
import { diagnosticsCommand } from "../../src/discord/commands/system/diagnostics.ts";
import { statusCommand } from "../../src/discord/commands/system/status.ts";
import type { SlashCommand } from "../../src/discord/commands/types.ts";
import { OPTION_TYPE } from "../../src/discord/registry.ts";
import type { SetupDeps } from "../../src/setup/deps.ts";

const DOC_PATH = fileURLToPath(new URL("../../docs/commands.md", import.meta.url));
const DOCS_DIR = fileURLToPath(new URL("../../docs/", import.meta.url));

// the deps are never read while the command list is built, only inside a
// command's run, so a stub is enough to get the names. the boot passes the
// real ones.
const commands: SlashCommand[] = [
  statusCommand(() => {
    throw new Error("the status probe is never called by this test");
  }),
  diagnosticsCommand([]),
  ...setupCommands({} as unknown as SetupDeps),
  ...backupCommands({} as unknown as BackupDeps),
  ...restoreCommands({} as unknown as RestoreDeps),
];

// the registered surface, read off the same definitions the boot registers.
const definitions = buildDefinitions(commands);
const registeredGroups = new Set(definitions.map((definition) => definition.name));
const registeredPaths = new Set<string>();
for (const definition of definitions) {
  const subcommands = (definition.options ?? []).filter(
    (option) => option.type === OPTION_TYPE.subCommand,
  );
  if (subcommands.length === 0) {
    registeredPaths.add(definition.name);
    continue;
  }
  for (const subcommand of subcommands) {
    registeredPaths.add(`${definition.name} ${subcommand.name}`);
  }
}

/** a command reference: a group on its own, or a group and a subcommand. */
interface Token {
  readonly group: string;
  readonly subcommand: string | null;
}

// `/setup`, `/setup open`. a slash, a lowercase name, and optionally a second
// word. anything else in the doc is prose, a path, or an option name.
const TOKEN = /^\/([a-z][a-z0-9_-]*)(?:\s+([a-z0-9_-]+))?$/;
const INLINE_CODE = /`([^`\n]+)`/g;
const HEADING = /^##\s+(.+)$/gm;

/** every command the doc names, in the order it names them. */
function tokensIn(doc: string): Token[] {
  const found: Token[] = [];
  const consider = (raw: string): void => {
    const match = TOKEN.exec(raw.trim());
    if (match === null) return;
    found.push({ group: match[1] ?? "", subcommand: match[2] ?? null });
  };
  for (const match of doc.matchAll(INLINE_CODE)) consider(match[1] ?? "");
  for (const match of doc.matchAll(HEADING)) consider(match[1] ?? "");
  return found;
}

/** the command a token names, as one string. */
function nameOf(token: Token): string {
  return token.subcommand === null ? token.group : `${token.group} ${token.subcommand}`;
}

let doc = "";
let docTokens: Token[] = [];

beforeAll(async () => {
  doc = await readFile(DOC_PATH, "utf8");
  docTokens = tokensIn(doc);
});

describe("docs/commands.md", () => {
  test("the doc names every command registered at boot", () => {
    const named = new Set(docTokens.map(nameOf));
    const missing = [...registeredPaths].filter((path) => !named.has(path)).sort();
    expect(missing).toEqual([]);
  });

  test("the doc names no command that does not exist", () => {
    const unknown = docTokens
      .filter((token) => {
        if (token.subcommand === null) return !registeredGroups.has(token.group);
        return !registeredPaths.has(`${token.group} ${token.subcommand}`);
      })
      .map(nameOf);
    expect([...new Set(unknown)].sort()).toEqual([]);
  });

  test("the doc covers every registered group", () => {
    const named = new Set(docTokens.map((token) => token.group));
    expect([...registeredGroups].filter((group) => !named.has(group)).sort()).toEqual([]);
  });

  test("the guide table points at files that exist", async () => {
    const paths = [...doc.matchAll(/`(docs\/[a-z0-9-]+\.md)`/g)].map((match) => match[1] ?? "");
    expect(paths.length).toBeGreaterThan(0);
    const missing: string[] = [];
    for (const path of paths) {
      const read = await readFile(`${DOCS_DIR}${path.replace("docs/", "")}`, "utf8");
      if (read.length === 0) missing.push(path);
    }
    expect(missing).toEqual([]);
  });
});
