// the pages the web layer renders. server-rendered html, one file per page, and
// nothing in them that a person did not ask for: no trackers, no third-party
// requests, no embedded scripts beyond the fingerprint the plan names.

export interface PageInput {
  readonly title: string;
  readonly body: string;
  /** the guild the page is about, when there is one. */
  readonly guildName?: string | null;
  readonly guildIconUrl?: string | null;
}

/** the shell every page shares. the css is inline: one request, no tracker. */
export function page(input: PageInput): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(input.title)}</title>
<style>
:root { color-scheme: light dark; }
body { font-family: system-ui, sans-serif; margin: 0; padding: 2rem; line-height: 1.5; }
main { max-width: 40rem; margin: 0 auto; }
h1 { font-size: 1.4rem; }
a.button { display: inline-block; padding: 0.6rem 1rem; border-radius: 0.4rem; background: #5865f2; color: #fff; text-decoration: none; }
.muted { color: #6b7280; font-size: 0.9rem; }
</style>
</head>
<body>
<main>
${input.body}
</main>
</body>
</html>`;
}

/** the landing page. with a guild it says whose server this is; without one it
 *  says nothing about a server at all. */
export function homePage(input: {
  readonly guildId: string | null;
  readonly guildName: string | null;
  readonly guildIconUrl: string | null;
  readonly verifyUrl: string | null;
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}): string {
  const guild =
    input.guildId === null
      ? ""
      : `<p>server: <strong>${escapeHtml(input.guildName ?? input.guildId)}</strong></p>`;
  const icon =
    input.guildIconUrl === null
      ? ""
      : `<img src="${escapeHtml(input.guildIconUrl)}" alt="" width="64" height="64" style="border-radius:8px">`;
  const button =
    input.verifyUrl === null
      ? `<p class="muted">this page is not linked to a server yet.</p>`
      : `<p><a class="button" href="${escapeHtml(input.verifyUrl)}">Verify</a></p>`;

  return page({
    title: "snapback verification",
    body: `<h1>snapback verification</h1>
${icon}
${guild}
${button}
<p class="muted">verification is how a server proves who is in it. it is optional, and it is revocable.</p>
<p><a href="${escapeHtml(input.disclosureUrl)}">what is captured, and why</a> · <a href="${escapeHtml(input.revokeUrl)}">revoke your access</a></p>`,
  });
}

/** the result page after a verification. */
export function resultPage(input: {
  readonly ok: boolean;
  readonly guildName: string | null;
  readonly detail: string;
  readonly disclosureUrl: string;
  readonly revokeUrl: string;
}): string {
  const heading = input.ok ? "verified" : "verification did not finish";
  return page({
    title: heading,
    body: `<h1>${escapeHtml(heading)}</h1>
${input.guildName === null ? "" : `<p>server: <strong>${escape(input.guildName)}</strong></p>`}
<p>${escapeHtml(input.detail)}</p>
<p><a href="${escapeHtml(input.disclosureUrl)}">what is captured, and why</a> · <a href="${escapeHtml(input.revokeUrl)}">revoke your access</a></p>`,
  });
}

/** the disclosure page. the same text the wizard's privacy step writes, so the
 *  two cannot drift apart. */
export function legalPage(input: { readonly disclosure: string }): string {
  return page({
    title: "what is captured, and why",
    body: `<h1>what is captured, and why</h1>
${input.disclosure
  .split("\n")
  .map((line) => `<p>${escapeHtml(line)}</p>`)
  .join("\n")}`,
  });
}

/** the health page. json, not html: it is for a probe, not for a person. */
export function healthJson(input: Record<string, unknown>): string {
  return JSON.stringify(input, null, 2);
}

/** html needs escaping. an unescaped value in a page is an injection. */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
