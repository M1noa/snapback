// renders the operator docs (docs/*.md) inside discord, so a guide cannot drift
// from what the bot does (D4PLAN 22, D4TODO phase 13). the markdown is the same
// file the repo ships; this module only paginates it and lays it out.

import type { ContainerComponent } from "oceanic.js";
import { textDisplay } from "../discord/components/fields.ts";
import { type ListAction, listRow, page } from "../discord/components/page.ts";
import { actionRow, customID, stringSelect } from "../discord/components/row.ts";
import type { DocReader } from "./deps.ts";

/** one shipped guide. name matches a file in docs/ and its /setup guide key. */
export interface GuideDoc {
  readonly name: string;
  readonly title: string;
  readonly summary: string;
}

/** the guides `/setup guide` and `/snapback help` can render, in index order. */
export const GUIDE_DOCS: readonly GuideDoc[] = Object.freeze([
  { name: "commands", title: "Commands", summary: "every command, option, and default" },
  { name: "setup", title: "Setup", summary: "clone to a running, verified bot" },
  {
    name: "developer-panel",
    title: "Developer panel",
    summary: "the discord portal toggles, redirect strings, and intents",
  },
  {
    name: "cloudflare-tunnel",
    title: "Cloudflare Tunnel",
    summary: "running behind a tunnel, and the loopback ip failure",
  },
  {
    name: "scopes",
    title: "OAuth2 scopes",
    summary: "every scope, what it grants, and what snapback stores",
  },
  {
    name: "self-hosting",
    title: "Self-hosting",
    summary: "postgres, the data files, retention, and the honest limits",
  },
  {
    name: "troubleshooting",
    title: "Troubleshooting",
    summary: "the failures that actually happen, by symptom and error code",
  },
  {
    name: "backup-format",
    title: "Backup format",
    summary: "the backup json contract, and what a restore cannot bring back",
  },
  {
    name: "privacy",
    title: "Privacy",
    summary: "what is captured about a visitor, and in which form",
  },
  {
    name: "architecture",
    title: "Architecture",
    summary: "the layers, the layout, and where the seams are",
  },
  {
    name: "contributing",
    title: "Contributing",
    summary: "the gate, the house rules, and the two remotes",
  },
]);

/** the body the guide page shows when docs/ has no such file in this build. */
const EMPTY_DOC = "this doc is not shipped in this build";

// a page is one text display plus one control row, so it is nowhere near the 40
// component cap. the budget that matters is readability: about 3000 characters
// of markdown fits a screenful without a wall of scroll.
const PAGE_CHAR_BUDGET = 3000;

const FENCE = "```";

// split markdown at blank lines, but keep a fenced code block whole: a fence is
// one block however many blank lines it contains, so packing can never cut it.
function splitBlocks(markdown: string): string[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = (): void => {
    const text = current.join("\n").trim();
    if (text.length > 0) blocks.push(text);
    current = [];
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!inFence) {
      if (trimmed.length === 0) {
        flush();
        continue;
      }
      current.push(line);
      if (trimmed.startsWith(FENCE)) inFence = true;
      continue;
    }
    // inside a fence: keep every line, and close on the next fence marker.
    current.push(line);
    if (trimmed.startsWith(FENCE)) {
      inFence = false;
      flush();
    }
  }
  flush();
  return blocks;
}

// pack whole blocks into chunks under the budget. a single block larger than the
// budget gets its own page rather than being cut, which is what keeps a big code
// fence on one page.
function pack(blocks: readonly string[], budget: number): string[] {
  const chunks: string[] = [];
  let buf: string[] = [];
  let size = 0;

  for (const block of blocks) {
    const candidate = buf.length === 0 ? block.length : size + 2 + block.length;
    if (buf.length > 0 && candidate > budget) {
      chunks.push(buf.join("\n\n"));
      buf = [];
      size = 0;
    }
    if (buf.length === 0) {
      buf.push(block);
      size = block.length;
    } else {
      buf.push(block);
      size += 2 + block.length;
    }
  }
  if (buf.length > 0) chunks.push(buf.join("\n\n"));
  return chunks;
}

function clampPage(page: number, pages: number): number {
  const wanted = Number.isFinite(page) ? Math.trunc(page) : 1;
  return Math.min(Math.max(wanted, 1), pages);
}

/** split a doc into pages and return them all, plus the requested page clamped
 *  into range. `chunks[page - 1]` is the requested page's text. */
export function paginateMarkdown(
  markdown: string,
  page: number,
): { readonly chunks: readonly string[]; readonly page: number; readonly pages: number } {
  const chunks = pack(splitBlocks(markdown), PAGE_CHAR_BUDGET);
  if (chunks.length === 0) chunks.push("");
  const pages = chunks.length;
  return { chunks, page: clampPage(page, pages), pages };
}

/** the object slot of a guide control is the doc name, so a page's own buttons
 *  say which doc they belong to. the cursor is the page number. */
export function guideObject(name: string): string {
  return name;
}

/** the verbs a guide page carries. there is no export: the markdown is already a
 *  file in docs/, so there is nothing to hand back. */
export const GUIDE_ACTIONS: readonly ListAction[] = Object.freeze([
  "page-prev",
  "page",
  "page-next",
  "filter",
]);

/** the doc picker's id. its value is the doc to open, so the cursor stays empty
 *  and the control is the same on every guide. */
export function guideFilterId(guildId: string, docName: string): string {
  return customID({
    surface: "setup",
    guild: guildId,
    object: guideObject(docName),
    action: "filter",
    cursor: "",
  });
}

/** the doc index: what `filter` shows, and where a doc is picked. */
export function guideIndex(guildId: string, currentDoc: string): ContainerComponent {
  return page({
    state: "info",
    title: "guides",
    sections: [
      textDisplay("every guide this build ships, rendered from `docs/`."),
      textDisplay(GUIDE_DOCS.map((doc) => `- **${doc.name}** ${doc.summary}`).join("\n")),
    ],
    controls: [
      actionRow([
        stringSelect({
          id: guideFilterId(guildId, currentDoc),
          placeholder: "read a guide",
          options: GUIDE_DOCS.map((doc) => ({
            label: doc.title,
            value: doc.name,
            description: doc.summary.slice(0, 100),
            default: doc.name === currentDoc,
          })),
        }),
      ]),
    ],
  });
}

/** one page of a guide, ready to send. reads a missing doc through the empty
 *  state rather than throwing, so `/setup guide` never crashes on a build that
 *  ships fewer files. */
export async function guidePage(
  deps: { readonly docs: DocReader; readonly guildId: string },
  name: string,
  requested: number,
): Promise<ContainerComponent> {
  const found = GUIDE_DOCS.find((doc) => doc.name === name);
  const title = found?.title ?? name;
  const markdown = await deps.docs(name);

  const empty = markdown === null;
  const {
    chunks,
    page: current,
    pages,
  } = empty ? { chunks: [EMPTY_DOC], page: 1, pages: 1 } : paginateMarkdown(markdown, requested);

  return page({
    state: "info",
    title,
    sections: [textDisplay(chunks[current - 1] ?? "")],
    controls: [
      listRow({
        parts: { surface: "setup", guild: deps.guildId, object: guideObject(name) },
        page: current,
        pages,
        actions: GUIDE_ACTIONS,
      }),
    ],
  });
}
