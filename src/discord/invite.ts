// the oauth2 invite url. the permission set is the bot's working set, read off
// the REST routes the services call, not administrator. the rule for keeping it
// honest: a new route with new powers means its bit joins this list.
//
// bit values mirror oceanic's Permissions enum; this module stays free of it.

const CAPTURE = [1024n, 65536n]; // view channels, read message history
const CONFIG = [32n, 16n]; // manage server (onboarding, welcome, vanity, widget, automod), manage channels
const REBUILD = [268435456n, 536870912n, 1073741824n, 8589934592n]; // manage roles, webhooks, emojis+stickers, scheduled events
const RESTORE = [17179869184n, 2048n, 2n]; // manage threads (archive state), send messages (verify panel), ban list

const PERMISSIONS = [...CAPTURE, ...CONFIG, ...REBUILD, ...RESTORE].reduce((a, b) => a | b, 0n);

/** the invite url for the app: the bot scope plus slash commands, at least
 *  privilege. every guild interaction the check happens in code, not here. */
export function inviteLink(clientId: string): string {
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot+applications.commands&permissions=${PERMISSIONS}`;
}
