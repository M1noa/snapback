// the one page builder. every multi-step surface goes through it so the layout
// is identical everywhere (D4PLAN 9.2, AGENTS.md consistency).

import {
  ButtonStyles,
  type ContainerComponent,
  type MessageActionRow,
  SeparatorSpacingSize,
} from "oceanic.js";
import { STATUS, type Status } from "./colors.ts";
import { type ContainerChild, container } from "./container.ts";
import { separator, textDisplay } from "./fields.ts";
import { actionRow, button, type CustomIDParts, customID } from "./row.ts";

// components v2 allows 40 per message, total, including nested children. this is
// the budget that shapes pagination (D4PLAN 9).
export const PAGE_LIMIT = 40;

// count every node in the tree: a section's accessory and a label's inner
// control each cost a slot, exactly as the api counts them (AGENTS.md rule 2).
export function countComponents(value: unknown): number {
  if (value === null || typeof value !== "object") return 0;
  const node = value as {
    type?: unknown;
    components?: unknown;
    accessory?: unknown;
    component?: unknown;
  };
  let total = typeof node.type === "number" ? 1 : 0;
  if (Array.isArray(node.components)) {
    for (const child of node.components) total += countComponents(child);
  }
  if (node.accessory !== undefined) total += countComponents(node.accessory);
  if (node.component !== undefined) total += countComponents(node.component);
  return total;
}

function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

export interface PageInput {
  state: Status;
  title: string;
  sections: ContainerChild[];
  controls?: MessageActionRow[];
  empty?: string;
}

// one container, accent by status, a title line carrying the status word, body
// sections, a separator, then at most two rows of controls. throws in
// development when the tree overflows the cap; truncates with a visible footer
// in production (D4PLAN 9.2).
export function page(input: PageInput): ContainerComponent {
  const { state, title, controls = [] } = input;
  if (controls.length > 2) throw new Error("page: at most two control rows");
  const style = STATUS[state];
  const body =
    input.sections.length > 0 ? input.sections : [textDisplay(input.empty ?? "nothing here yet")];
  const children: ContainerChild[] = [textDisplay(`## ${title}\n-# ${style.word}`), ...body];
  if (controls.length > 0) {
    children.push(separator({ divider: true, spacing: SeparatorSpacingSize.LARGE }));
    children.push(...controls);
  }
  const tree = container({ accent: style.accent, children });
  const total = countComponents(tree);
  if (total <= PAGE_LIMIT) return tree;
  if (isProduction()) return truncate(tree);
  throw new Error(`page: ${total} components exceeds the ${PAGE_LIMIT} cap`);
}

function truncate(tree: ContainerComponent): ContainerComponent {
  const children = [...tree.components];
  // one slot for the container, one for the footer.
  const budget = PAGE_LIMIT - 2;
  while (children.length > 0 && countChildren(children) > budget) children.pop();
  children.push(textDisplay("-# page truncated: too much to show at once"));
  return { ...tree, components: children };
}

function countChildren(children: ContainerChild[]): number {
  let total = 0;
  for (const child of children) total += countComponents(child);
  return total;
}

export interface ListRowOptions {
  // surface, guild, and object; the row fills in the action and cursor.
  parts: Omit<CustomIDParts, "action" | "cursor">;
  page: number;
  pages: number;
}

// the one control row every list surface uses: previous, page N of M, next,
// filter, export. identical everywhere on purpose (AGENTS.md consistency).
export function listRow(opts: ListRowOptions): MessageActionRow {
  const { parts, page: current, pages } = opts;
  const at = (action: string, cursor: string) => customID({ ...parts, action, cursor });
  return actionRow([
    button({
      id: at("page-prev", String(current - 1)),
      label: "previous",
      style: ButtonStyles.SECONDARY,
      disabled: current <= 1,
    }),
    button({
      id: at("page", String(current)),
      label: `page ${current} of ${pages}`,
      style: ButtonStyles.SECONDARY,
      disabled: true,
    }),
    button({
      id: at("page-next", String(current + 1)),
      label: "next",
      style: ButtonStyles.SECONDARY,
      disabled: current >= pages,
    }),
    button({ id: at("filter", String(current)), label: "filter", style: ButtonStyles.SECONDARY }),
    button({ id: at("export", String(current)), label: "export", style: ButtonStyles.SECONDARY }),
  ]);
}
