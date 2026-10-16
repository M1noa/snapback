// process entry. resolves and prints the config, then boots (src/boot.ts).
//
// `--print-config` prints the same banner and stops before anything opens a
// socket or a file: it is the check an operator runs after editing .env, and the
// only boot path a test can run without a bot token.

import { boot } from "./boot.ts";
import { env, envWarnings } from "./config/env.ts";

const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  version: string;
};

for (const warning of envWarnings) {
  process.stderr.write(`config: ${warning.key}: ${warning.text}\n`);
}

const db = env.db.isPostgres ? "postgres" : env.db.file;

const banner = [
  `snapback ${manifest.version}`,
  `  db        ${db}`,
  `  web       ${env.web.publicBaseUrl} on :${env.web.port}`,
  `  ip        ${env.privacy.ipStorage}`,
  `  tokens    ${env.privacy.tokenStorage ? "encrypted at rest" : "storage unavailable"}`,
  `  intel     ${env.intel.enabled ? "on" : "off"}`,
  `  pull      ${env.limits.pullDailyLimitPerAccount}/account/day`,
  `  owner     ${env.discord.ownerId}`,
].join("\n");

process.stdout.write(`${banner}\n`);
if (process.argv.includes("--print-config")) process.exit(0);

// a boot failure is reported as one line here and a non-zero exit. the detail is
// already in the log, with discord's own words where discord was the one talking.
let running: Awaited<ReturnType<typeof boot>>;
try {
  running = await boot();
} catch (error) {
  const reason = error instanceof Error ? error.message : String(error);
  process.stderr.write(`snapback could not start: ${reason}\n`);
  process.exit(1);
}

let stopping = false;
async function shutdown(signal: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  running.log.info("shutting down", { signal });
  await running.stop();
  process.exit(0);
}

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}
