// process entry. phase 1 proves the wiring boots and the config validates;
// the discord client, scheduler, and web server attach here as they land.

import { env, envWarnings } from "./config/env.ts";

const manifest = (await Bun.file(new URL("../package.json", import.meta.url)).json()) as {
  version: string;
};

for (const warning of envWarnings) {
  process.stderr.write(`config: ${warning.key}: ${warning.text}\n`);
}

const db = env.db.isPostgres ? "postgres" : env.db.file;

const boot = [
  `snapback ${manifest.version}`,
  `  db        ${db}`,
  `  web       ${env.web.publicBaseUrl} on :${env.web.port}`,
  `  ip        ${env.privacy.ipStorage}`,
  `  tokens    ${env.privacy.tokenStorage ? "encrypted at rest" : "storage unavailable"}`,
  `  intel     ${env.intel.enabled ? "on" : "off"}`,
  `  pull      ${env.limits.pullDailyLimitPerAccount}/account/day`,
  `  owner     ${env.discord.ownerId}`,
].join("\n");

process.stdout.write(`${boot}\n`);
