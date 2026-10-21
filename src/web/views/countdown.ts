// the result page's close countdown. it counts six seconds, then asks the
// browser to close the tab, and leaves a truthful sentence behind if the browser
// refuses (a tab a person navigated to themselves cannot be closed by script).
//
// the text and its hash live together for the same reason the fingerprint does:
// the content security policy allows this script by hash, so editing the script
// edits the policy, and the policy cannot name a script that is not this one.

/** seconds the page waits before it tries to close the tab. */
export const CLOSE_SECONDS = 6;

const RAW_SCRIPT = `
(function () {
  var el = document.getElementById("sb-close");
  if (!el) return;
  var left = ${CLOSE_SECONDS};
  var paint = function () {
    el.textContent = left > 0
      ? "This tab closes in " + left + "s."
      : "Done. You can close this tab.";
  };
  paint();
  var tick = setInterval(function () {
    left -= 1;
    paint();
    if (left > 0) return;
    clearInterval(tick);
    // a browser that refuses leaves the sentence above standing.
    try { window.close(); } catch (e) { /* nothing to do; the note stands. */ }
  }, 1000);
})();
`;

/** the script as a page would embed it. */
export function countdownScript(): string {
  return `<script>${RAW_SCRIPT}</script>`;
}

/** the sha256 the policy must allow this script by. */
export const COUNTDOWN_SCRIPT_HASH: string = new Bun.CryptoHasher("sha256")
  .update(RAW_SCRIPT)
  .digest("base64");
