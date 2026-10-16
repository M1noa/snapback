// the binding between the process environment and the validated config. this is
// the only module that reads Bun.env, and the only one that exits.

import { type Env, type EnvWarning, parseEnv, readProcessEnv } from "./parse-env.ts";

const parsed = parseEnv(readProcessEnv);

if (!parsed.ok) {
  process.stderr.write(`snapback cannot start, ${parsed.problems.length} problem(s):\n`);
  for (const [index, text] of parsed.problems.entries()) {
    process.stderr.write(`  ${index + 1}. ${text}\n`);
  }
  process.exit(1);
}

export const env: Env = parsed.env;
export const envWarnings: readonly EnvWarning[] = parsed.warnings;
