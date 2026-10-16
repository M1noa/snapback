import { describe, expect, test } from "bun:test";
import { STATUS } from "../../src/discord/components/colors.ts";
import {
  type ContainerChild,
  container,
  IS_COMPONENTS_V2,
  v2Message,
} from "../../src/discord/components/container.ts";
import {
  file,
  mediaGallery,
  section,
  separator,
  textDisplay,
  thumbnail,
} from "../../src/discord/components/fields.ts";
import { countComponents, listRow, PAGE_LIMIT, page } from "../../src/discord/components/page.ts";
import {
  actionRow,
  button,
  channelSelect,
  checkbox,
  checkboxGroup,
  customID,
  fileUpload,
  label,
  mentionableSelect,
  modal,
  parseCustomID,
  radioGroup,
  roleSelect,
  stringSelect,
  textInput,
  userSelect,
} from "../../src/discord/components/row.ts";

describe("colors", () => {
  test("is the one five-colour map from D4PLAN 9.4", () => {
    expect(STATUS.info.accent).toBe(0x5865f2);
    expect(STATUS.success.accent).toBe(0x57f287);
    expect(STATUS.warning.accent).toBe(0xfee75c);
    expect(STATUS.danger.accent).toBe(0xed4245);
    expect(STATUS.busy.accent).toBe(0xeb459e);
  });

  test("every state carries a word from the fixed set", () => {
    const words = new Set(["done", "failed", "running", "waiting"]);
    for (const style of Object.values(STATUS)) expect(words.has(style.word)).toBe(true);
  });
});

describe("fields", () => {
  test("text display is type 10", () => {
    expect(textDisplay("hi")).toEqual({ type: 10, content: "hi" });
  });

  test("separator defaults divider true, spacing small", () => {
    expect(separator()).toEqual({ type: 14, divider: true, spacing: 1 });
    expect(separator({ divider: false, spacing: 2 })).toEqual({
      type: 14,
      divider: false,
      spacing: 2,
    });
  });

  test("thumbnail, media gallery, file shapes", () => {
    expect(thumbnail("https://x/y.png")).toEqual({
      type: 11,
      media: { url: "https://x/y.png" },
      description: null,
      spoiler: undefined,
    });
    expect(mediaGallery([{ url: "https://x/y.png" }])).toEqual({
      type: 12,
      items: [{ media: { url: "https://x/y.png" }, description: null, spoiler: undefined }],
    });
    expect(file("attachment://a.png")).toEqual({
      type: 13,
      file: { url: "attachment://a.png" },
      spoiler: undefined,
    });
  });

  test("section takes texts and one accessory", () => {
    const s = section({ texts: [textDisplay("a"), textDisplay("b")], accessory: thumbnail("u") });
    expect(s.type).toBe(9);
    expect(s.components).toHaveLength(2);
    expect(s.accessory.type).toBe(11);
  });

  test("section rejects empty text and a bad accessory", () => {
    expect(() => section({ texts: [], accessory: thumbnail("u") })).toThrow("1-3");
    expect(() => section({ texts: [textDisplay("a")], accessory: separator() as never })).toThrow(
      "thumbnail or a button",
    );
  });
});

describe("row: controls", () => {
  test("action row is type 1", () => {
    expect(actionRow([button({ id: "sb:x:1:y:a", label: "go", style: 1 })])).toEqual({
      type: 1,
      components: [{ type: 2, style: 1, customID: "sb:x:1:y:a", label: "go" }],
    });
  });

  test("interactive button uses camelCase customID", () => {
    const b = button({ id: "id", label: "confirm", style: 3, disabled: true });
    expect(b).toEqual({ type: 2, style: 3, customID: "id", label: "confirm", disabled: true });
    expect("customID" in b).toBe(true);
    expect("custom_id" in b).toBe(false);
  });

  test("link button carries a url and no customID", () => {
    const b = button({ style: 5, url: "https://x", label: "open" });
    expect(b).toEqual({ type: 2, style: 5, url: "https://x", label: "open" });
    expect("customID" in b).toBe(false);
  });

  test("buttons fail loudly when a required field is missing", () => {
    expect(() => button({ style: 1 })).toThrow("customID");
    expect(() => button({ style: 5 })).toThrow("url");
  });

  test("string select is type 3 with min/max applied", () => {
    const s = stringSelect({
      id: "id",
      placeholder: "pick",
      options: [{ label: "a", value: "a" }],
      minValues: 1,
      maxValues: 3,
    });
    expect(s.type).toBe(3);
    expect(s.customID).toBe("id");
    expect(s.minValues).toBe(1);
    expect(s.maxValues).toBe(3);
    expect(s.options).toEqual([{ label: "a", value: "a" }]);
  });

  test("entity selects carry the right type numbers", () => {
    expect(userSelect({ id: "i" }).type).toBe(5);
    expect(roleSelect({ id: "i" }).type).toBe(6);
    expect(mentionableSelect({ id: "i" }).type).toBe(7);
    expect(channelSelect({ id: "i", channelTypes: [0] }).type).toBe(8);
  });

  test("modal controls carry the right type numbers", () => {
    expect(label({ label: "x", component: textInput({ id: "i" }) }).type).toBe(18);
    expect(textInput({ id: "i" }).type).toBe(4);
    expect(fileUpload({ id: "i" }).type).toBe(19);
    expect(checkbox({ id: "i" }).type).toBe(23);
    expect(checkboxGroup({ id: "i", options: [] }).type).toBe(22);
    expect(radioGroup({ id: "i", options: [] }).type).toBe(21);
  });

  test("label wraps its component", () => {
    const l = label({ label: "name", component: textInput({ id: "n", style: 2 }) });
    expect(l.label).toBe("name");
    expect(l.component).toEqual({
      type: 4,
      customID: "n",
      style: 2,
      label: undefined,
      placeholder: undefined,
      minLength: undefined,
      maxLength: undefined,
      required: undefined,
      value: undefined,
    });
  });

  test("modal carries its labels", () => {
    const m = modal({
      id: "sb:m:1:o:a",
      title: "t",
      components: [label({ label: "l", component: textInput({ id: "i" }) })],
    });
    expect(m.customID).toBe("sb:m:1:o:a");
    expect(m.components[0]?.type).toBe(18);
  });
});

describe("container", () => {
  test("is type 17 with accentColor and children", () => {
    const c = container({ accent: 0x5865f2, children: [textDisplay("x")] });
    expect(c.type).toBe(17);
    expect(c.accentColor).toBe(0x5865f2);
    expect(c.components).toHaveLength(1);
  });

  test("the v2 flag is 32768", () => {
    expect(IS_COMPONENTS_V2).toBe(32768);
    expect(v2Message(container({ children: [] })).flags).toBe(32768);
  });

  test("rejects an accent outside 0x000000-0xFFFFFF", () => {
    expect(() => container({ accent: 0x1000000, children: [] })).toThrow("outside");
  });

  test("rejects a nested container", () => {
    const inner = container({ children: [] });
    const nested = { children: [inner as unknown as ContainerChild] };
    expect(() => container(nested)).toThrow("cannot nest");
  });
});

describe("customID", () => {
  test("builds the sb namespace", () => {
    expect(
      customID({
        surface: "backup",
        guild: "123",
        object: "456",
        action: "page-next",
        cursor: "2",
      }),
    ).toBe("sb:backup:123:456:page-next:2");
  });

  test("round-trips through the parser", () => {
    const parts = { surface: "backup", guild: "123", object: "456", action: "filter", cursor: "2" };
    expect(parseCustomID(customID(parts))).toEqual(parts);
  });

  test("round-trips without a cursor", () => {
    const parts = { surface: "setup", guild: "9", object: "o", action: "open" };
    expect(parseCustomID(customID(parts))).toEqual(parts);
  });

  test("parser returns null on anything malformed", () => {
    for (const bad of ["", "sb", "xx:a:b:c:d", "sb:a:b", "sb:a:b:c:d:e:f", "sb:a:b:c:d:e:!"]) {
      expect(parseCustomID(bad)).toBeNull();
    }
  });

  test("rejects an over-long id and a separator inside a token", () => {
    expect(() => customID({ surface: "a:b", guild: "1", object: "2", action: "x" })).toThrow(
      "bad token",
    );
    expect(() =>
      customID({ surface: "s", guild: "1", object: "2", action: "x", cursor: "9".repeat(100) }),
    ).toThrow("exceeds");
  });
});

describe("countComponents", () => {
  test("counts a section and its accessory", () => {
    const s = section({ texts: [textDisplay("a"), textDisplay("b")], accessory: thumbnail("u") });
    // 1 section + 2 texts + 1 thumbnail.
    expect(countComponents(s)).toBe(4);
  });

  test("counts nested children all the way down", () => {
    const c = container({
      children: [
        section({ texts: [textDisplay("a")], accessory: thumbnail("u") }),
        actionRow([
          button({ id: "i", label: "x", style: 2 }),
          button({ id: "j", label: "y", style: 2 }),
        ]),
      ],
    });
    // 1 container + (1 section + 1 text + 1 thumbnail) + (1 row + 2 buttons).
    expect(countComponents(c)).toBe(7);
  });

  test("counts a label's inner control", () => {
    const l = label({ label: "x", component: radioGroup({ id: "i", options: [] }) });
    expect(countComponents(l)).toBe(2);
  });
});

describe("page", () => {
  test("accents by status and carries the status word", () => {
    const tree = page({ state: "success", title: "backup done", sections: [textDisplay("ok")] });
    expect(tree.type).toBe(17);
    expect(tree.accentColor).toBe(0x57f287);
    expect(tree.components[0]).toEqual({ type: 10, content: "## backup done\n-# done" });
  });

  test("a neutral page still names a word", () => {
    const tree = page({ state: "info", title: "t", sections: [textDisplay("x")] });
    expect((tree.components[0] as { content: string }).content).toContain("-# waiting");
  });

  test("empty state says something", () => {
    const tree = page({ state: "info", title: "t", sections: [] });
    expect((tree.components[1] as { content: string }).content).toContain("nothing here yet");
    const named = page({ state: "info", title: "t", sections: [], empty: "no backups yet" });
    expect((named.components[1] as { content: string }).content).toBe("no backups yet");
  });

  test("puts a separator before the controls", () => {
    const tree = page({
      state: "info",
      title: "t",
      sections: [textDisplay("x")],
      controls: [
        listRow({ parts: { surface: "backup", guild: "1", object: "o" }, page: 1, pages: 3 }),
      ],
    });
    const kinds = tree.components.map((c) => c.type);
    expect(kinds).toEqual([10, 10, 14, 1]);
  });

  test("refuses more than two control rows", () => {
    const row = listRow({ parts: { surface: "s", guild: "1", object: "o" }, page: 1, pages: 1 });
    expect(() =>
      page({ state: "info", title: "t", sections: [], controls: [row, row, row] }),
    ).toThrow("two control rows");
  });

  test("throws when the tree overflows the cap", () => {
    const sections = Array.from({ length: PAGE_LIMIT }, () => textDisplay("filler"));
    expect(() => page({ state: "info", title: "t", sections })).toThrow(`${PAGE_LIMIT}`);
  });

  test("a page at the cap does not throw", () => {
    // container(1) + title(1) + separator(1) + row with 5 buttons(6) = 9 fixed,
    // so 31 body sections land the tree on exactly 40.
    const sections = Array.from({ length: 31 }, () => textDisplay("filler"));
    const tree = page({
      state: "info",
      title: "t",
      sections,
      controls: [listRow({ parts: { surface: "s", guild: "1", object: "o" }, page: 1, pages: 1 })],
    });
    expect(countComponents(tree)).toBe(PAGE_LIMIT);
  });
});

describe("listRow", () => {
  test("is the same five-button row with a page indicator", () => {
    const row = listRow({
      parts: { surface: "backup", guild: "123", object: "456" },
      page: 2,
      pages: 5,
    });
    expect(row.type).toBe(1);
    expect(row.components).toHaveLength(5);
    const labels = row.components.map((c) => (c as { label: string }).label);
    expect(labels).toEqual(["previous", "page 2 of 5", "next", "filter", "export"]);

    const prev = row.components[0] as { customID: string; disabled: boolean };
    const next = row.components[2] as { customID: string; disabled: boolean };
    expect(prev.customID).toBe("sb:backup:123:456:page-prev:1");
    expect(prev.disabled).toBe(false);
    expect(next.customID).toBe("sb:backup:123:456:page-next:3");
    expect(next.disabled).toBe(false);
  });

  test("disables previous on the first page and next on the last", () => {
    const first = listRow({ parts: { surface: "s", guild: "1", object: "o" }, page: 1, pages: 3 });
    const last = listRow({ parts: { surface: "s", guild: "1", object: "o" }, page: 3, pages: 3 });
    expect((first.components[0] as { disabled: boolean }).disabled).toBe(true);
    expect((last.components[2] as { disabled: boolean }).disabled).toBe(true);
  });
});
