// /setup (D4PLAN 8, 10): the hub, one subcommand per wizard step, and the guides.
//
// a step subcommand goes through openSetup rather than rendering a step page here.
// that is the one path that hands an unfinished wizard over to whoever ran the
// command (D4PLAN 10.4), and it is what returns the rendered container.

import type { SetupDeps } from "../../../setup/deps.ts";
import { GUIDE_DOCS, type GuideDoc, guideIndex, guidePage } from "../../../setup/guide.ts";
import { openSetup, statusPage } from "../../../setup/handlers.ts";
import { WIZARD_STEPS } from "../../../setup/state.ts";
import { type CommandOption, OPTION_TYPE } from "../../registry.ts";
import type { CommandContext, CommandOptionValue, CommandResult, SlashCommand } from "../types.ts";

const GROUP = "setup";

// the steps the wizard walks itself: the intro, scopes (the verify step owns
// those), and the finish. every other step is a jump target, and that list comes
// from the wizard's own table, so a step added there appears here without a second
// list to keep in step.
const WIZARD_ONLY: ReadonlySet<string> = new Set(["welcome", "scopes", "finish"]);

// the index of the guides belongs to no single doc, and a guide id's object slot is
// the doc name, so the index is keyed on a token that cannot collide with one.
// row.ts refuses an empty object slot, which is what an empty string here would be.
const GUIDE_INDEX = "index";

const GUIDE_OPTIONS: readonly CommandOption[] = [
  {
    name: "doc",
    description: "the guide to read, or the index of them all",
    type: OPTION_TYPE.string,
    // the doc list is the one place a guide is named, so a guide cannot be added
    // without being reachable from here.
    choices: GUIDE_DOCS.map((doc) => ({ name: doc.title, value: doc.name })),
  },
  {
    name: "page",
    description: "the page of the guide to open",
    type: OPTION_TYPE.integer,
    min_value: 1,
    max_value: 999,
  },
];

function chosenDoc(value: CommandOptionValue): GuideDoc | undefined {
  if (typeof value !== "string") return undefined;
  return GUIDE_DOCS.find((doc) => doc.name === value);
}

function stepCommands(deps: SetupDeps): SlashCommand[] {
  return WIZARD_STEPS.filter((step) => !WIZARD_ONLY.has(step.key)).map((step) => ({
    group: GROUP,
    subcommand: step.key,
    description: step.summary,
    async run(ctx: CommandContext): Promise<CommandResult> {
      const opened = await openSetup({
        deps,
        guildId: ctx.guildId,
        userId: ctx.userId,
        stepKey: step.key,
      });
      return { page: opened, ephemeral: true };
    },
  }));
}

/** every subcommand of /setup, all in one group. */
export function setupCommands(deps: SetupDeps): SlashCommand[] {
  return [
    {
      group: GROUP,
      subcommand: "open",
      description: "open the wizard at the first incomplete step",
      async run(ctx: CommandContext): Promise<CommandResult> {
        const opened = await openSetup({ deps, guildId: ctx.guildId, userId: ctx.userId });
        return { page: opened, ephemeral: true };
      },
    },
    {
      group: GROUP,
      subcommand: "status",
      description: "every step, what is done, and what is still open",
      async run(ctx: CommandContext): Promise<CommandResult> {
        const settings = await deps.store.read(ctx.guildId);
        return { page: statusPage(ctx.guildId, settings), ephemeral: true };
      },
    },
    ...stepCommands(deps),
    {
      group: GROUP,
      subcommand: "guide",
      description: "read the operator docs, or the index of them all",
      options: GUIDE_OPTIONS,
      async run(ctx: CommandContext): Promise<CommandResult> {
        const doc = chosenDoc(ctx.options.doc);
        const page = typeof ctx.options.page === "number" ? ctx.options.page : 1;
        const container =
          doc === undefined
            ? guideIndex(ctx.guildId, GUIDE_INDEX)
            : await guidePage({ docs: deps.docs, guildId: ctx.guildId }, doc.name, page);
        return { page: container, ephemeral: true };
      },
    },
  ];
}
