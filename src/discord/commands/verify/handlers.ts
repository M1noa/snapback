// the /verify controls.
//
// erasing captured data is guarded three ways: the instance owner alone may do
// it, the page says how much of the record goes, and the operator types the
// person's name before it happens.

import type { VerifyPanelRow } from "../../../db/types.ts";
import { mirror } from "../../../services/tracking/mirror.ts";
import { label, textInput } from "../../components/row.ts";
import { failurePage } from "../../interactions/dispatch.ts";
import type { Handler, HandlerContext, HandlerResult, Router } from "../../interactions/router.ts";
import {
  VERIFY_ACTION,
  VERIFY_OBJECT,
  VERIFY_SURFACE,
  type VerifyDeps,
  verifyCustomId,
} from "./deps.ts";
import { deletePage, jobPage, panelPage, startPage } from "./pages.ts";
import { recordPageFor, recordsPageFor } from "./support.ts";

type Container = Parameters<HandlerContext["surface"]["reply"]>[0]["message"];

async function answer(ctx: HandlerContext, message: Container): Promise<HandlerResult> {
  await ctx.surface.reply({ message, ephemeral: true, update: true });
  return { kind: "reply" };
}

/** the object slots the surface owns. anything else in the object slot is a
 *  panel id, because a panel's button carries its own id. */
const KNOWN_OBJECTS: ReadonlySet<string> = new Set(Object.values(VERIFY_OBJECT));

/** the value a select submitted, or null. */
function selected(ctx: HandlerContext, id: string): string | null {
  const value = ctx.surface.values[id];
  if (typeof value === "string") return value;
  if (Array.isArray(value) && typeof value[0] === "string") return value[0];
  return null;
}

/** the values a checkbox group submitted. */
function checked(ctx: HandlerContext, id: string): string[] {
  const value = ctx.surface.values[id];
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  if (typeof value === "string") return [value];
  return [];
}

/**
 * the "open" verb, on two objects: the panel's channel select and the records'
 * paging. the router keys on the verb, so the object slot says which one this is.
 */
function openHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    // the panel's own button carries the panel id in the object slot, so an
    // object that is none of ours is a panel: pressing it starts the flow.
    if (!KNOWN_OBJECTS.has(ctx.id.object)) {
      const url = await deps.authorizeUrl(ctx.id.guild, ctx.id.object);
      if (url === null) {
        return await answer(
          ctx,
          failurePage(
            "the verification flow is off",
            "the bot has no oauth client secret, so it cannot start the flow.",
            undefined,
            "set OAUTH_CLIENT_SECRET in .env and restart.",
          ),
        );
      }
      return await answer(ctx, startPage({ guildId: ctx.id.guild, url }));
    }
    if (ctx.id.object === VERIFY_OBJECT.panel) {
      const existing = await deps.panel(ctx.id.guild);
      const channelId = selected(ctx, ctx.id.raw) ?? existing?.channel_id ?? null;
      const settings = await deps.settings(ctx.id.guild);
      const scopes = existing?.scopes_json ?? [];
      const restricted =
        scopes.includes("relationships.read") && settings.acknowledged_restricted_scopes === null;
      return await answer(
        ctx,
        panelPageFor(ctx.id.guild, {
          title: existing?.title ?? "server verification",
          description: existing?.description ?? "",
          scopes,
          buttonLabel: existing?.button_label ?? "Verify",
          channelId,
          restricted,
        }),
      );
    }
    const page = Number.parseInt(ctx.id.cursor, 10);
    return await answer(
      ctx,
      await recordsPageFor(deps, ctx.id.guild, Number.isFinite(page) && page > 0 ? page : 1),
    );
  };
}

/** a record was picked from the list. */
function selectHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    const userId = selected(ctx, ctx.id.raw);
    if (userId === null) {
      return await answer(
        ctx,
        failurePage("nothing was picked", "the list did not send a record."),
      );
    }
    const record = await deps.record(ctx.id.guild, userId);
    if (record === null) {
      return await answer(ctx, failurePage("that record is gone", "it was deleted or revoked."));
    }
    return await answer(ctx, recordPageFor(ctx.id.guild, record));
  };
}

/** the panel's scopes were submitted: the panel is created and posted. */
function panelSubmitHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    const scopeId = verifyCustomId({
      guildId: ctx.id.guild,
      object: VERIFY_OBJECT.panel,
      action: VERIFY_ACTION.submit,
    });
    const scopes = checked(ctx, scopeId);
    const channelId = selected(
      ctx,
      verifyCustomId({
        guildId: ctx.id.guild,
        object: VERIFY_OBJECT.panel,
        action: VERIFY_ACTION.open,
      }),
    );
    if (channelId === null) {
      return await answer(
        ctx,
        failurePage(
          "no channel was picked",
          "the panel goes in a channel, and the list did not send one.",
          undefined,
          "pick a channel and press the button again.",
        ),
      );
    }

    const settings = await deps.settings(ctx.id.guild);
    if (scopes.includes("relationships.read") && settings.acknowledged_restricted_scopes === null) {
      return await answer(
        ctx,
        failurePage(
          "the friends list scope needs an acknowledgement",
          "discord gates that scope behind the Social SDK, and the wizard has not recorded that you accept its terms.",
          undefined,
          "run /setup verify scopes and accept the restricted scope, then try again.",
        ),
      );
    }

    const existing = await deps.panel(ctx.id.guild);
    const details = readDetails(ctx, existing);
    const panel = await deps.savePanel({
      guildId: ctx.id.guild,
      channelId,
      title: details.title,
      description: details.description,
      scopes,
      buttonLabel: details.buttonLabel,
      color: details.color,
      thumbnailUrl: details.thumbnailUrl,
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "verify.panel.saved",
      target: panel.panel_id,
      detail: { scopes },
    });

    return await answer(
      ctx,
      jobPage({
        guildId: ctx.id.guild,
        lines: [
          `the panel is in <#${channelId}>.`,
          `it asks for: ${scopes.join(", ") || "nothing"}.`,
        ],
        state: "success",
        refreshId: verifyCustomId({
          guildId: ctx.id.guild,
          object: VERIFY_OBJECT.job,
          action: VERIFY_ACTION.refresh,
        }),
      }),
    );
  };
}

/**
 * the panel's copy and its look. the button opens a modal with the fields, and
 * the modal's submit saves them, so the panel can say what it is for in the
 * operator's own words (D4PLAN 10.3).
 */
function detailsHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    const existing = await deps.panel(ctx.id.guild);
    const id = verifyCustomId({
      guildId: ctx.id.guild,
      object: VERIFY_OBJECT.panel,
      action: VERIFY_ACTION.details,
    });

    if (ctx.surface.source !== "modal") {
      await ctx.surface.openModal({
        customID: id,
        title: "the panel's copy",
        components: [
          label({
            label: "the title",
            description: "the line at the top of the panel.",
            component: textInput({
              id: `${id}:title`,
              style: 1,
              required: true,
              maxLength: 80,
              value: existing?.title ?? "server verification",
            }),
          }),
          label({
            label: "what it is for",
            description:
              "the copy under the title. say what the server wants the verification for.",
            component: textInput({
              id: `${id}:description`,
              style: 2,
              required: false,
              maxLength: 1000,
              value: existing?.description ?? "",
            }),
          }),
          label({
            label: "the button's label",
            description: "what the button says. keep it to the point.",
            component: textInput({
              id: `${id}:label`,
              style: 1,
              required: true,
              maxLength: 80,
              value: existing?.button_label ?? "Verify",
            }),
          }),
          label({
            label: "the accent",
            description: "a hex colour, like 5865f2. the panel is this colour.",
            component: textInput({
              id: `${id}:color`,
              style: 1,
              required: false,
              maxLength: 6,
              value: hexOf(existing?.color ?? null),
            }),
          }),
          label({
            label: "a thumbnail",
            description: "the url of an image, or leave it empty.",
            component: textInput({
              id: `${id}:thumbnail`,
              style: 1,
              required: false,
              maxLength: 300,
              value: existing?.thumbnail_url ?? "",
            }),
          }),
        ],
      });
      return { kind: "reply" };
    }

    const details = readDetails(ctx, existing);
    const channelId =
      selected(
        ctx,
        verifyCustomId({
          guildId: ctx.id.guild,
          object: VERIFY_OBJECT.panel,
          action: VERIFY_ACTION.open,
        }),
      ) ?? existing?.channel_id;
    if (channelId === null || channelId === undefined) {
      return await answer(
        ctx,
        failurePage(
          "no channel was picked",
          "the panel goes in a channel, and the list did not send one.",
          undefined,
          "pick a channel and press the button again.",
        ),
      );
    }
    const panel = await deps.savePanel({
      guildId: ctx.id.guild,
      channelId,
      title: details.title,
      description: details.description,
      scopes: existing?.scopes_json ?? [],
      buttonLabel: details.buttonLabel,
      color: details.color,
      thumbnailUrl: details.thumbnailUrl,
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "verify.panel.saved",
      target: panel.panel_id,
      detail: { scopes: existing?.scopes_json ?? [] },
    });
    return await answer(
      ctx,
      jobPage({
        guildId: ctx.id.guild,
        lines: [`the panel's copy is saved. it is in <#${channelId}>.`],
        state: "success",
        refreshId: verifyCustomId({
          guildId: ctx.id.guild,
          object: VERIFY_OBJECT.job,
          action: VERIFY_ACTION.refresh,
        }),
      }),
    );
  };
}

/** the values the modal carried, with the stored ones where a field is empty. */
function readDetails(
  ctx: HandlerContext,
  existing: VerifyPanelRow | null,
): {
  title: string;
  description: string;
  buttonLabel: string;
  color: string;
  thumbnailUrl: string | null;
} {
  const id = ctx.id.raw;
  const field = (name: string): string | null => {
    const value = ctx.surface.values[`${id}:${name}`];
    if (typeof value === "string" && value !== "") return value;
    if (Array.isArray(value) && typeof value[0] === "string" && value[0] !== "") return value[0];
    return null;
  };
  return {
    title: field("title") ?? existing?.title ?? "server verification",
    description: field("description") ?? existing?.description ?? "",
    buttonLabel: field("label") ?? existing?.button_label ?? "Verify",
    color: field("color") ?? hexOf(existing?.color ?? null),
    thumbnailUrl: field("thumbnail") ?? existing?.thumbnail_url ?? null,
  };
}

/** the accent as the hex the operator types. */
function hexOf(color: number | null): string {
  if (color === null) return "5865f2";
  return color.toString(16).padStart(6, "0");
}

/**
 * the "delete" verb, on two objects: the records' delete button opens the page
 * that says how much goes, and the scope group on that page mints the nonce the
 * modal carries.
 */
function deleteHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    if (ctx.id.object === VERIFY_OBJECT.record) {
      return await scopeSubmission(deps, ctx);
    }
    const userId = ctx.id.cursor;
    const record = await deps.record(ctx.id.guild, userId);
    if (record === null) {
      return await answer(ctx, failurePage("that record is gone", "it was deleted or revoked."));
    }
    return await answer(
      ctx,
      deletePage({
        guildId: ctx.id.guild,
        userId,
        username: record.username ?? "unknown",
        scopes: [
          { key: "record", what: "the row: the identity, the scopes, the network" },
          { key: "ip", what: "the address, in whatever form it was stored" },
          { key: "token", what: "the access and refresh tokens" },
        ],
        submitId: verifyCustomId({
          guildId: ctx.id.guild,
          object: VERIFY_OBJECT.record,
          action: VERIFY_ACTION.delete,
          cursor: userId,
        }),
        backId: verifyCustomId({
          guildId: ctx.id.guild,
          object: VERIFY_OBJECT.records,
          action: VERIFY_ACTION.open,
        }),
      }),
    );
  };
}

/** the scope was chosen: the modal asks for the name, so a stray click cannot
 *  erase anything. */
async function scopeSubmission(deps: VerifyDeps, ctx: HandlerContext): Promise<HandlerResult> {
  {
    const userId = ctx.id.cursor;
    const record = await deps.record(ctx.id.guild, userId);
    if (record === null) {
      return await answer(ctx, failurePage("that record is gone", "it was deleted or revoked."));
    }
    const scopes = checked(ctx, ctx.id.raw);
    const nonce = await deps.state.put({
      guildId: ctx.id.guild,
      userId: ctx.identity.userId,
      surface: VERIFY_SURFACE,
      payload: { action: "delete", userId, scopes },
    });
    const id = verifyCustomId({
      guildId: ctx.id.guild,
      object: VERIFY_OBJECT.record,
      action: VERIFY_ACTION.confirm,
      cursor: nonce,
    });
    await ctx.surface.openModal({
      customID: id,
      title: "type the name to confirm",
      components: [
        label({
          label: "the person's name",
          description: "it has to match exactly, so a stray click cannot erase anything.",
          component: textInput({ id, style: 1, required: true, maxLength: 32 }),
        }),
      ],
    });
    return { kind: "reply" };
  }
}

/** the modal's submit: the name decides, and then the data goes. */
function confirmHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    const nonce = await deps.state.get(ctx.id.cursor);
    if (nonce === null) {
      return await answer(ctx, failurePage("that confirmation expired", "try again."));
    }
    await deps.state.delete(ctx.id.cursor);
    if (nonce.userId !== ctx.identity.userId || nonce.guildId !== ctx.id.guild) {
      return await answer(
        ctx,
        failurePage("that confirmation is not yours", "it will not be used."),
      );
    }
    if (ctx.identity.userId !== deps.ownerId) {
      return await answer(
        ctx,
        failurePage(
          "only the instance owner can erase this",
          "the captured data belongs to the people who were verified, so erasing it is the owner's call alone.",
        ),
      );
    }

    const payload = nonce.payload as { userId?: string; scopes?: string[] };
    const userId = typeof payload.userId === "string" ? payload.userId : "";
    const record = await deps.record(ctx.id.guild, userId);
    if (record === null) {
      return await answer(ctx, failurePage("that record is gone", "it was deleted or revoked."));
    }

    const typed = selected(ctx, ctx.id.raw) ?? "";
    if (typed.trim() !== (record.username ?? "unknown")) {
      return await answer(
        ctx,
        failurePage(
          "that is not the name",
          "the name has to match exactly, so a stray click cannot erase a record.",
          undefined,
          `type \`${record.username ?? "unknown"}\` and press the button again.`,
        ),
      );
    }

    const scopes = payload.scopes ?? [];
    const scope = scopes.includes("all")
      ? "all"
      : scopes.includes("ip")
        ? "ip"
        : scopes.includes("token")
          ? "token"
          : "record";
    const deleted = await deps.deleteRecord({ guildId: ctx.id.guild, userId, scope });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "verify.record.deleted",
      target: userId,
      detail: { scope, what: deleted.what },
    });

    return await answer(ctx, await recordsPageFor(deps, ctx.id.guild, 1));
  };
}

/** revoke a person's access without erasing what was captured. */
function revokeHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    const userId = ctx.id.cursor;
    const deleted = await deps.deleteRecord({
      guildId: ctx.id.guild,
      userId,
      scope: "token",
    });
    await deps.audit({
      guildId: ctx.id.guild,
      actorUserId: ctx.identity.userId,
      action: "verify.record.revoked",
      target: userId,
      detail: { what: deleted.what },
    });
    await mirror(deps.tracking, deps.log, {
      guildId: ctx.id.guild,
      subjectKind: "user",
      subjectId: userId,
      kind: "verify_revoked",
      actorId: ctx.identity.userId,
      source: "verify",
      detail: { what: deleted.what },
    });
    const record = await deps.record(ctx.id.guild, userId);
    if (record === null) {
      return await answer(ctx, await recordsPageFor(deps, ctx.id.guild, 1));
    }
    return await answer(ctx, recordPageFor(ctx.id.guild, record));
  };
}

/** the refresh button: a sweep over many records is a job. */
function refreshHandler(deps: VerifyDeps): Handler {
  return async (ctx) => {
    const job = await deps.jobs.enqueue("verify_refresh", {
      guildId: ctx.id.guild,
      requestedBy: ctx.identity.userId,
      payload: { guildId: ctx.id.guild },
    });
    return await answer(
      ctx,
      jobPage({
        guildId: ctx.id.guild,
        lines: [`job \`${job.id.slice(0, 8)}\` is refreshing the tokens that are due.`],
        state: "info",
        refreshId: verifyCustomId({
          guildId: ctx.id.guild,
          object: VERIFY_OBJECT.job,
          action: VERIFY_ACTION.refresh,
        }),
      }),
    );
  };
}

/** the panel page, with the channel that was picked. */
function panelPageFor(
  guildId: string,
  input: {
    title: string;
    description: string;
    scopes: readonly string[];
    buttonLabel: string;
    channelId: string | null;
    restricted: boolean;
  },
): Container {
  return panelPage({
    guildId,
    channelId: input.channelId,
    title: input.title,
    description: input.description,
    scopes: input.scopes,
    buttonLabel: input.buttonLabel,
    restrictedWithoutAcknowledgement: input.restricted,
    channelSelectId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.panel,
      action: VERIFY_ACTION.open,
    }),
    scopeGroupId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.panel,
      action: VERIFY_ACTION.submit,
    }),
    submitId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.panel,
      action: VERIFY_ACTION.submit,
    }),
    detailsId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.panel,
      action: VERIFY_ACTION.details,
    }),
    backId: verifyCustomId({
      guildId,
      object: VERIFY_OBJECT.records,
      action: VERIFY_ACTION.open,
    }),
  });
}

export function registerVerifyHandlers(router: Router, deps: VerifyDeps): void {
  router.register(VERIFY_SURFACE, VERIFY_ACTION.open, openHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.select, selectHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.submit, panelSubmitHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.details, detailsHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.delete, deleteHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.confirm, confirmHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.refresh, refreshHandler(deps));
  router.register(VERIFY_SURFACE, VERIFY_ACTION.revoke, revokeHandler(deps));
}
