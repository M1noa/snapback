// phase 0 spike: prove oceanic 1.15 can carry a components v2 container as a plain
// object and that we can count the tree against the 40 short-circuit. offline, no token.
//
// evidence for the claims in this file:
//   - MessageFlags.IS_COMPONENTS_V2 = 32768            node_modules/oceanic.js/dist/lib/Constants.d.ts:724
//   - ComponentTypes enum numbers                       node_modules/oceanic.js/dist/lib/Constants.d.ts:625
//   - component field names (camelCase)                 node_modules/oceanic.js/dist/lib/types/channels.d.ts:1398-1666
//   - "40 total components"                             discord-api-docs developers/components/reference.mdx:18
//   - content/embeds cannot be used with the flag       channels.d.ts:353 (CreateMessageOptions.components docstring)

import assert from "node:assert/strict";
import type { ContainerComponent, CreateMessageOptions } from "oceanic.js";
import { ButtonStyles, ComponentTypes, MessageFlags, SeparatorSpacingSize } from "oceanic.js";

// ---------------------------------------------------------------------------
// 1. the flag
// ---------------------------------------------------------------------------

// 1 << 15. setting it disables content, embeds and stickerIDs on that message, and
// once set discord will not let it be removed. confirmed at runtime, not read once.
assert.equal(MessageFlags.IS_COMPONENTS_V2, 32768);
assert.equal(MessageFlags.IS_COMPONENTS_V2, 1 << 15);

// ---------------------------------------------------------------------------
// 2. builders or plain objects
// ---------------------------------------------------------------------------

// oceanic ships no component builder classes. `Util` only reshapes raw snake_case
// payloads into the camelCase shape; it does not construct. `QueryBuilder` in util/
// is a url querystring helper, unrelated. so components are plain objects and the
// only thing enforcing shape is the interface types. the annotation below is that
// enforcement: a wrong field name fails typecheck.
assert.equal(typeof (ComponentTypes as unknown), "object"); // enum object, not a class factory

// ---------------------------------------------------------------------------
// 3. the type numbers (these become discord/components/ constants)
// ---------------------------------------------------------------------------

const TYPE = {
  ACTION_ROW: 1,
  BUTTON: 2,
  STRING_SELECT: 3,
  TEXT_INPUT: 4,
  USER_SELECT: 5,
  ROLE_SELECT: 6,
  MENTIONABLE_SELECT: 7,
  CHANNEL_SELECT: 8,
  SECTION: 9,
  TEXT_DISPLAY: 10,
  THUMBNAIL: 11,
  MEDIA_GALLERY: 12,
  FILE: 13,
  SEPARATOR: 14,
  CONTAINER: 17,
  LABEL: 18,
  FILE_UPLOAD: 19,
  RADIO_GROUP: 21,
  CHECKBOX_GROUP: 22,
  CHECKBOX: 23,
} as const;

// every number above must equal the library's enum, so a drift in oceanic is caught here
for (const [name, value] of Object.entries(TYPE)) {
  assert.equal(
    ComponentTypes[name as keyof typeof ComponentTypes],
    value,
    `ComponentTypes.${name}`,
  );
}
// note the gaps: 15, 16 (CONTENT_INVENTORY_ENTRY), 20 are skipped or unshipped.
assert.equal(ComponentTypes.CONTENT_INVENTORY_ENTRY, 16);

// multi-select: there is no separate multi-select type number. a string select that
// takes several values is still STRING_SELECT (3); multi is maxValues > 1. likewise
// the resolved selects (user/role/mentionable/channel) are 5-8 and multi via maxValues.
// the only true single-vs-multi component pair by type is checkbox (23) vs checkbox group (22).

// ---------------------------------------------------------------------------
// 4. the tree, built as a plain object with camelCase keys
// ---------------------------------------------------------------------------

const container: ContainerComponent = {
  type: ComponentTypes.CONTAINER,
  accentColor: 0x5865_f2, // info/blurple, D4PLAN 9.4
  components: [
    {
      type: ComponentTypes.SECTION,
      // section body: 1-3 text displays
      components: [{ type: ComponentTypes.TEXT_DISPLAY, content: "**snapback** restore plan" }],
      // exactly one accessory: a thumbnail here
      accessory: { type: ComponentTypes.THUMBNAIL, media: { url: "attachment://guild.png" } },
    },
    { type: ComponentTypes.SEPARATOR, divider: true, spacing: SeparatorSpacingSize.SMALL },
    {
      type: ComponentTypes.ACTION_ROW,
      // buttons share one row, max 5
      components: [
        {
          type: ComponentTypes.BUTTON,
          style: ButtonStyles.PRIMARY,
          customID: "sb:restore:1:plan:run:0",
          label: "run",
        },
        {
          type: ComponentTypes.BUTTON,
          style: ButtonStyles.DANGER,
          customID: "sb:restore:1:plan:cancel:0",
          label: "cancel",
        },
      ],
    },
    {
      type: ComponentTypes.ACTION_ROW,
      // a select is alone in its row; it cannot share with buttons
      components: [
        {
          type: ComponentTypes.STRING_SELECT,
          customID: "sb:restore:1:cats:pick:0",
          placeholder: "categories to restore",
          minValues: 0,
          maxValues: 5,
          options: [
            { label: "roles", value: "roles" },
            { label: "channels", value: "channels" },
            { label: "messages", value: "messages" },
          ],
        },
      ],
    },
  ],
};

// field names that had to come from the library types rather than a guess:
//   accentColor   (not accent_color)      channels.d.ts:1623
//   accessory     (section)               channels.d.ts:1556
//   media         (thumbnail, wraps url)  channels.d.ts:1568
//   file          (file component, url)   channels.d.ts:1610
//   customID      (not custom_id)         channels.d.ts:1427,1472
//   minValues/maxValues                   channels.d.ts:1474-1475
// the raw snake_case forms (accent_color, custom_id, min_values) are what oceanic
// sends on the wire; the object we hand it is always camelCase.

// ---------------------------------------------------------------------------
// 5. the payload that carries it
// ---------------------------------------------------------------------------

// Message.reply / TextableChannel.createMessage / CommandInteraction.createMessage /
// ComponentInteraction.createMessage all take Types.Channels.CreateMessageOptions
// (or InteractionContent, which picks the same fields). flags + components together:
const message: CreateMessageOptions = {
  flags: MessageFlags.IS_COMPONENTS_V2,
  components: [container],
};

assert.ok(!("content" in message), "v2 message carries no content");
assert.ok(!("embeds" in message), "v2 message carries no embeds");
assert.equal(message.flags, 32768);
// the type does not forbid content at compile time; discord rejects it at runtime.
// the constraint is documented on the field, not encoded in the type:
//   channels.d.ts:353 "the IS_COMPONENTS_V2 flag must be provided to use any of the
//   v2 components, and with this enabled `content`, `embeds`, and `stickerIDs` cannot be used."

// ---------------------------------------------------------------------------
// 6. the recursive counter
// ---------------------------------------------------------------------------

// a component is any node with a `type`. children live under `components`
// (container/action row/section), `accessory` (section), and `component` (label).
// select `options` and media gallery `items` are not components, so they are not walked.
interface Walkable {
  type: number;
  components?: Walkable[];
  accessory?: Walkable;
  component?: Walkable;
}

function countComponents(node: Walkable | Walkable[]): number {
  if (Array.isArray(node)) return node.reduce((n, child) => n + countComponents(child), 0);
  let n = 1; // the node itself
  if (node.components) n += countComponents(node.components);
  if (node.accessory) n += countComponents(node.accessory);
  if (node.component) n += countComponents(node.component);
  return n;
}

// the whole message's component tree, top level array included
const total = countComponents([container]);
// container, section, text display, thumbnail, separator, action row, button x2,
// action row, string select
assert.equal(total, 10);
assert.equal(countComponents([container]), countComponents(container)); // array of one == the node

// every nested node is counted: the accessory and both action rows' children are in
assert.ok(total > 1 + 4, "counter must descend past the container's direct children");

// ---------------------------------------------------------------------------
// 7. the 40 cap
// ---------------------------------------------------------------------------

const CAP = 40;

// page() in production asserts against this instead of letting a message fail at discord.
function assertWithinCap(tree: Walkable | Walkable[]): number {
  const count = countComponents(tree);
  if (count > CAP) throw new Error(`component tree is ${count}, over the ${CAP} cap`);
  return count;
}

assert.equal(assertWithinCap([container]), 10);

// a deliberately over-cap tree must throw, so the guard is real and not a no-op
const over: Walkable = {
  type: TYPE.CONTAINER,
  components: Array.from({ length: CAP + 1 }, () => ({ type: TYPE.TEXT_DISPLAY }) as Walkable),
};
assert.throws(() => assertWithinCap(over), /over the 40 cap/);

// the cap is nested-inclusive: discord's docs say "Messages allow up to 40 total
// components" (reference.mdx:18). "total" plus the nesting model (container child
// components, section child components, action row children) means children count.
// discord does not print a separate sentence spelling that out, so this is the
// reading we are committing to, on the word "total".

console.log("oceanic cv2 spike ok");
console.log(`  IS_COMPONENTS_V2 = ${MessageFlags.IS_COMPONENTS_V2}`);
console.log(`  tree count       = ${total} / ${CAP}`);
