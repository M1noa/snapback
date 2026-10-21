// the landing page's continue button. a tab that a script opened is a tab the
// result page is allowed to close again; a plain link leaves a tab the person
// navigated to, which the browser refuses to shut. so the click opens the
// discord url itself, and only when a window actually comes back does it stop
// the normal navigation. a blocked popup falls through to the href and the
// flow still works, it just cannot close itself at the end.
//
// text and hash live together for the same reason the countdown's do: the
// policy allows this script by hash.

const RAW_SCRIPT = `
(function () {
  var link = document.getElementById("sb-open");
  if (!link) return;
  link.addEventListener("click", function (event) {
    // anything but a plain left click is the person asking for a tab, or a
    // download, or a new window: leave the default alone.
    if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var opened = null;
    try { opened = window.open(link.href, "_blank"); } catch (e) { opened = null; }
    if (opened) event.preventDefault();
  });
})();
`;

/** the script as a page would embed it. */
export function openerScript(): string {
  return `<script>${RAW_SCRIPT}</script>`;
}

/** the sha256 the policy must allow this script by. */
export const OPENER_SCRIPT_HASH: string = new Bun.CryptoHasher("sha256")
  .update(RAW_SCRIPT)
  .digest("base64");
