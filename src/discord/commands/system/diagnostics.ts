// /snapback diagnostics (D4PLAN 8, 7.6). runs every probe and returns a report
// the operator can copy into a support thread.
//
// the report is a fenced block so discord gives it a copy button. one probe
// failing must not stop the others: a diagnostics page that dies on the first
// problem is useless exactly when it is needed.

import { textDisplay } from "../../components/fields.ts";
import { page } from "../../components/page.ts";
import type { CommandContext, CommandResult, SlashCommand } from "../types.ts";

export type ProbeState = "ok" | "warn" | "fail";

export interface ProbeResult {
  /** short label, used as the report line's key. */
  readonly name: string;
  readonly state: ProbeState;
  /** one line. what was checked and what came back. */
  readonly detail: string;
}

export interface Probe {
  readonly name: string;
  run(): Promise<ProbeResult> | ProbeResult;
}

const MARK: Readonly<Record<ProbeState, string>> = {
  ok: "ok  ",
  warn: "warn",
  fail: "FAIL",
};

// a probe that throws is a failed probe, not a failed page. the message is kept
// verbatim so the operator sees what the probe said, not a rewrite.
async function runProbe(probe: Probe): Promise<ProbeResult> {
  try {
    return await probe.run();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name: probe.name, state: "fail", detail: `probe threw: ${detail}` };
  }
}

export function diagnosticsCommand(probes: readonly Probe[]): SlashCommand {
  return {
    group: "snapback",
    subcommand: "diagnostics",
    description: "run every self-test and return a copyable report",
    async run(_ctx: CommandContext): Promise<CommandResult> {
      const results = await Promise.all(probes.map(runProbe));

      const failed = results.filter((r) => r.state === "fail").length;
      const warned = results.filter((r) => r.state === "warn").length;
      const state = failed > 0 ? "danger" : warned > 0 ? "warning" : "success";

      const summary =
        failed > 0
          ? `${failed} failed, ${warned} warned, ${results.length - failed - warned} ok`
          : warned > 0
            ? `${warned} warned, ${results.length - warned} ok`
            : `all ${results.length} checks passed`;

      const report = results
        .map((result) => `${MARK[result.state]}  ${result.name}: ${result.detail}`)
        .join("\n");

      return {
        page: page({
          state,
          title: "diagnostics",
          sections: [
            textDisplay(summary),
            textDisplay(`\`\`\`\n${report}\n\`\`\``),
            textDisplay(
              failed > 0
                ? "-# copy the block above into a support thread. each failed line names what it checked."
                : "-# copy the block above when opening an issue.",
            ),
          ],
        }),
        ephemeral: true,
      };
    },
  };
}
