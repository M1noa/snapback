// the name the member surfaces show. the operator's override wins so a page can
// carry a name the server stopped using; with no override it is the server's own
// name (guilds.name, kept live by the gateway sync in boot.ts).

import type { GuildSettings } from "../config/defaults.ts";
import type { GuildRow } from "../db/types.ts";

export function displayName(settings: GuildSettings | null, row: GuildRow | null): string | null {
  return settings?.web_display_name ?? row?.name ?? null;
}
