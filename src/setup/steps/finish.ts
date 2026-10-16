// finish: the invite, the command list, the docs pointer, and what is left
// (D4PLAN 10.1 #11). apply() writes wizard.done_at, which is what marks the
// wizard complete; the cursor stays on this step so the page does not vanish.

import { ButtonStyles, type ContainerComponent } from "oceanic.js";
import type { GuildSettings } from "../../config/defaults.ts";
import type { ContainerChild } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button } from "../../discord/components/row.ts";
import { SETUP_OBJECT, type StepContext, type StepModule, setupCustomId } from "../deps.ts";
import { completeWizard, pendingSteps } from "../state.ts";

// the command doc lives at docs/commands.md. a short excerpt keeps the page to a
// screenful; the full list is one `/setup guide` away.
const MAX_EXCERPT_LINES = 12;
const MAX_EXCERPT_CHARS = 900;

// prefer the table rows that name a subcommand, so the excerpt is a command
// list and not the prose above it. fall back to the first lines when the doc has
// no such rows.
function commandExcerpt(doc: string): string {
  const lines = doc
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd());
  const commandRows = lines.filter((line) => /^\|\s*`\//.test(line.trim()));
  const source = commandRows.length > 0 ? commandRows : lines.filter((line) => line.trim() !== "");

  const kept: string[] = [];
  let chars = 0;
  for (const line of source) {
    if (kept.length >= MAX_EXCERPT_LINES || chars + line.length > MAX_EXCERPT_CHARS) break;
    kept.push(line);
    chars += line.length;
  }
  return kept.join("\n");
}

/** the lines naming what the wizard is still waiting on, one per pending step.
 *  empty once nothing is outstanding. exported so a test can assert it. */
export function finishSummary(settings: GuildSettings): string[] {
  return pendingSteps(settings).map(
    (step) => `- ${step.title}: ${step.summary} (step ${step.index + 1})`,
  );
}

export const finishStep: StepModule = {
  key: "finish",

  async render(ctx: StepContext): Promise<ContainerComponent> {
    const invite = ctx.deps.portal.invite();
    const commands = await ctx.deps.docs("commands");
    const outstanding = finishSummary(ctx.settings);

    const sections: ContainerChild[] = [
      textDisplay(`invite snapback to a server with this link:\n\`\`\`\n${invite}\n\`\`\``),
    ];

    if (commands === null) {
      sections.push(
        textDisplay(
          "the command list is not shipped in this build, so there is nothing to show here. the full list is in `docs/commands.md`.",
        ),
      );
    } else {
      sections.push(textDisplay(`commands:\n\`\`\`\n${commandExcerpt(commands)}\n\`\`\``));
    }

    sections.push(textDisplay("full operator guide: `docs/setup.md`, or run `/setup guide`."));
    sections.push(
      textDisplay(
        outstanding.length === 0
          ? "everything required is done. press finish setup to close the wizard."
          : ["still outstanding:", ...outstanding].join("\n"),
      ),
    );

    return page({
      state: "info",
      title: "finish",
      sections,
      controls: [
        actionRow([
          button({
            id: setupCustomId({
              guildId: ctx.guildId,
              object: SETUP_OBJECT.step,
              action: "finish",
            }),
            label: "finish setup",
            style: ButtonStyles.PRIMARY,
          }),
        ]),
      ],
    });
  },

  apply(ctx: StepContext): Partial<GuildSettings> {
    return { wizard: completeWizard(ctx.wizard, new Date(ctx.deps.now()).toISOString()) };
  },
};
