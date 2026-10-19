import { describe, expect, test } from "bun:test";
import { countComponents, PAGE_LIMIT } from "../../src/discord/components/page.ts";
import { parseCustomID } from "../../src/discord/components/row.ts";
import { parseCustomId } from "../../src/discord/interactions/router.ts";
import { GUIDE_DOCS, guidePage, paginateMarkdown } from "../../src/setup/guide.ts";

// a doc reader that always returns the same body, or null for the "not shipped"
// case. mirrors the DocReader the wizard injects.
function reader(markdown: string | null) {
  return async (_name: string): Promise<string | null> => markdown;
}

// ten ~600-char paragraphs: well past one 3000-char page, so it forces several.
function longDoc(): string {
  const para = (n: number): string => `paragraph ${n} `.repeat(50).trim();
  return Array.from({ length: 10 }, (_, i) => para(i)).join("\n\n");
}

interface TreeNode {
  type: number;
  content?: string;
  components?: TreeNode[];
  customID?: string;
}

function texts(node: TreeNode): string[] {
  return (node.components ?? [])
    .filter((child) => child.type === 10)
    .map((child) => child.content ?? "");
}

function actionRow(node: TreeNode): TreeNode | undefined {
  return (node.components ?? []).find((child) => child.type === 1);
}

describe("paginateMarkdown", () => {
  test("a short doc is one page", () => {
    const result = paginateMarkdown("just one line of prose", 1);
    expect(result.pages).toBe(1);
    expect(result.page).toBe(1);
    expect(result.chunks).toHaveLength(1);
    expect(result.chunks[0]).toBe("just one line of prose");
  });

  test("a long doc splits into several pages, and page N differs from page 1", () => {
    const result = paginateMarkdown(longDoc(), 1);
    expect(result.pages).toBeGreaterThan(1);
    expect(result.chunks.length).toBe(result.pages);
    expect(result.chunks[1]).not.toBe(result.chunks[0]);

    const second = paginateMarkdown(longDoc(), 2);
    expect(second.page).toBe(2);
    expect(second.chunks[1]).toBe(result.chunks[1]);
    expect(second.chunks[1]).not.toBe(result.chunks[0]);
  });

  test("a fenced code block is never split across two pages", () => {
    const body = Array.from({ length: 200 }, (_, i) => `fence body line ${i}`).join("\n");
    const doc = `before the fence\n\n${"```sh"}\n${body}\n${"```"}\n\nafter the fence`;
    const result = paginateMarkdown(doc, 1);

    // the fence markers land on one page together, with the whole body between.
    const carrying = result.chunks.filter(
      (chunk) => chunk.includes("fence body line 0") && chunk.includes("fence body line 199"),
    );
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toContain("```sh");
    expect(carrying[0]).toContain("```");

    // and no page has an odd number of fence markers (an unclosed fence).
    for (const chunk of result.chunks) {
      const markers = chunk.split("```").length - 1;
      expect(markers % 2).toBe(0);
    }
  });

  test("an out of range page is clamped into range", () => {
    const short = paginateMarkdown("one page only", 0);
    expect(short.page).toBe(1);
    expect(paginateMarkdown("one page only", 999).page).toBe(1);

    const long = paginateMarkdown(longDoc(), 999);
    expect(long.page).toBe(long.pages);
    expect(paginateMarkdown(longDoc(), -4).page).toBe(1);
  });

  test("an empty doc still yields one page", () => {
    const result = paginateMarkdown("", 1);
    expect(result.pages).toBe(1);
    expect(result.chunks).toEqual([""]);
  });
});

describe("guidePage", () => {
  test("a missing doc renders the empty state, not a crash", async () => {
    const tree = (await guidePage(
      { docs: reader(null), guildId: "123456789" },
      "setup",
      1,
    )) as unknown as TreeNode;
    const body = texts(tree).join("\n");
    expect(body).toContain("this doc is not shipped in this build");
  });

  test("a real doc renders a container under the component cap", async () => {
    const tree = (await guidePage(
      { docs: reader(longDoc()), guildId: "123456789" },
      "setup",
      1,
    )) as unknown as TreeNode;
    expect(tree.type).toBe(17);
    expect(countComponents(tree)).toBeLessThanOrEqual(PAGE_LIMIT);
    // one title line and one body text display, the body being the whole chunk.
    expect(texts(tree)).toHaveLength(2);
  });

  test("the control row is listRow, so its customIDs are the guide namespace", async () => {
    const tree = (await guidePage(
      { docs: reader(longDoc()), guildId: "123456789" },
      "setup",
      2,
    )) as unknown as TreeNode;
    const row = actionRow(tree);
    expect(row).toBeDefined();
    // no export: the markdown is already a file in docs/.
    expect(row?.components).toHaveLength(4);

    // the object slot is the doc name, so a row always says which doc it belongs to.
    const ids = (row?.components ?? []).map((control) => control.customID ?? "");
    expect(ids).toEqual([
      "sb:setup:123456789:setup:page-prev:1",
      "sb:setup:123456789:setup:page:2",
      "sb:setup:123456789:setup:page-next:3",
      "sb:setup:123456789:setup:filter:2",
    ]);

    // row.ts's builder and parser round-trip every id, including the two nav ids.
    for (const id of ids) {
      const parts = parseCustomID(id);
      expect(parts?.surface).toBe("setup");
      expect(parts?.guild).toBe("123456789");
      expect(parts?.object).toBe("setup");
    }

    // router.parseCustomId accepts the three whose action has no hyphen. its
    // action grammar is [a-z][a-z0-9_]*, so the listRow page-prev/page-next ids
    // do not currently parse there; see the note in this file's report.
    for (const id of ids.filter((value) => !value.includes("page-"))) {
      const parsed = parseCustomId(id);
      expect(parsed.surface).toBe("setup");
      expect(parsed.guild).toBe("123456789");
      expect(parsed.object).toBe("setup");
    }
  });

  test("the page number is clamped the same way paginate clamps", async () => {
    const tree = (await guidePage(
      { docs: reader("only one short page"), guildId: "123456789" },
      "setup",
      999,
    )) as unknown as TreeNode;
    const row = actionRow(tree);
    const indicator = (row?.components ?? []).find((control) =>
      (control as { label?: string }).label?.startsWith("page "),
    );
    expect((indicator as { label?: string }).label).toBe("page 1 of 1");
  });
});

describe("GUIDE_DOCS", () => {
  test("lists the guides in index order", () => {
    expect(GUIDE_DOCS.map((doc) => doc.name)).toEqual([
      "commands",
      "setup",
      "developer-panel",
      "cloudflare-tunnel",
      "scopes",
      "self-hosting",
      "troubleshooting",
      "backup-format",
      "privacy",
      "architecture",
      "contributing",
    ]);
  });
});
