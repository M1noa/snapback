// the one status-to-colour map from D4PLAN.md 9.4. an operator learns it once.
// no sixth colour, ever. each state also carries a word so status is never
// conveyed by colour alone (AGENTS.md, D4PLAN 9.6).

export type Status = "info" | "success" | "warning" | "danger" | "busy";

// the fixed four-word vocabulary a coloured container may use. D4PLAN 9.6 and
// AGENTS.md allow exactly these: done, failed, running, waiting.
export type StatusWord = "done" | "failed" | "running" | "waiting";

export interface StatusStyle {
  accent: number;
  word: StatusWord;
}

// five states, four words, so info and warning both read "waiting": a wizard
// waits on the user and a cooldown or a pending prune is a wait too.
export const STATUS: Readonly<Record<Status, StatusStyle>> = Object.freeze({
  info: { accent: 0x5865f2, word: "waiting" },
  success: { accent: 0x57f287, word: "done" },
  warning: { accent: 0xfee75c, word: "waiting" },
  danger: { accent: 0xed4245, word: "failed" },
  busy: { accent: 0xeb459e, word: "running" },
});

export function accentFor(status: Status): number {
  return STATUS[status].accent;
}

export function wordFor(status: Status): StatusWord {
  return STATUS[status].word;
}
