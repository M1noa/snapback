// branding: the two uploads and the display name (D4PLAN 10.1 #3, 10.2).
//
// the modal collects the bytes; apply() validates and crops them and applies
// them through ImageApplier. the upload is not queued as a job: it is one
// bounded request and the operator is waiting for the result, unlike a
// paginated capture that can run for minutes.

import {
  ButtonStyles,
  type ContainerComponent,
  type ModalComponent,
  TextInputStyles,
} from "oceanic.js";
import type { GuildSettings } from "../../config/defaults.ts";
import type { ContainerChild } from "../../discord/components/container.ts";
import { textDisplay } from "../../discord/components/fields.ts";
import { page } from "../../discord/components/page.ts";
import { actionRow, button, fileUpload, label, textInput } from "../../discord/components/row.ts";
import { boundedText } from "../../lib/validate.ts";
import {
  SETUP_OBJECT,
  type SetupDeps,
  SetupInputError,
  type StepContext,
  type StepModule,
  type StepValues,
  setupCustomId,
} from "../deps.ts";
import { ImageInputError, prepareImage } from "../image.ts";

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ACCEPTED = "png, jpeg, or gif";
const FILE_TYPES = [".png", ".jpg", ".jpeg", ".gif"] as const;

function idAvatar(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.step,
    action: "branding",
    cursor: "avatar",
  });
}

function idBanner(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.step,
    action: "branding",
    cursor: "banner",
  });
}

function idName(guildId: string): string {
  return setupCustomId({
    guildId,
    object: SETUP_OBJECT.step,
    action: "branding",
    cursor: "name",
  });
}

// a file upload contributes the id of its first attachment as a string.
function firstValue(value: unknown): string | undefined {
  if (typeof value === "string") return value === "" ? undefined : value;
  if (Array.isArray(value)) {
    const first: unknown = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return undefined;
}

async function readAndPrepare(
  deps: SetupDeps,
  attachmentId: string,
  field: "avatar" | "banner",
): Promise<string> {
  const file = await deps.files.read(attachmentId);
  try {
    return prepareImage(file.bytes, { maxBytes: MAX_IMAGE_BYTES, square: true }).dataUri;
  } catch (error) {
    if (error instanceof ImageInputError) {
      throw new SetupInputError(field, `${error.reason}. ${error.fix}`);
    }
    throw error;
  }
}

export const brandingStep: StepModule = {
  key: "branding",

  render(ctx: StepContext): ContainerComponent {
    const branding = ctx.settings.branding;
    const sections: ContainerChild[] = [
      textDisplay(
        [
          `upload a bot avatar, a banner, and a display name. nothing is uploaded until you submit the form.`,
          `accepted: ${ACCEPTED}. the ceiling is ${MAX_IMAGE_BYTES / (1024 * 1024)} MiB. an image that is not square is centre-cropped.`,
        ].join("\n"),
      ),
      textDisplay(
        [
          `display name: ${branding.display_name ?? "not set"}`,
          `avatar: ${branding.avatar_set ? "set" : "not set"}`,
          `banner: ${branding.banner_set ? "set" : "not set"}`,
        ].join("\n"),
      ),
    ];

    return page({
      state: "info",
      title: "branding",
      sections,
      controls: [
        actionRow([
          button({
            id: setupCustomId({
              guildId: ctx.guildId,
              object: SETUP_OBJECT.step,
              action: "branding",
            }),
            label: "set avatar, banner, and name",
            style: ButtonStyles.PRIMARY,
          }),
        ]),
      ],
    });
  },

  modal(ctx: StepContext): { title: string; components: ModalComponent[] } {
    const current = ctx.settings.branding.display_name ?? undefined;
    return {
      title: "branding",
      components: [
        label({
          label: "avatar",
          description: ACCEPTED,
          component: fileUpload({
            id: idAvatar(ctx.guildId),
            minValues: 0,
            maxValues: 1,
            required: false,
            fileTypes: [...FILE_TYPES],
          }),
        }),
        label({
          label: "banner",
          description: ACCEPTED,
          component: fileUpload({
            id: idBanner(ctx.guildId),
            minValues: 0,
            maxValues: 1,
            required: false,
            fileTypes: [...FILE_TYPES],
          }),
        }),
        label({
          label: "display name",
          component: textInput({
            id: idName(ctx.guildId),
            style: TextInputStyles.SHORT,
            maxLength: 32,
            required: false,
            value: current,
          }),
        }),
      ],
    };
  },

  async apply(ctx: StepContext, values: StepValues): Promise<Partial<GuildSettings>> {
    const branding = ctx.settings.branding;
    let avatarSet = branding.avatar_set;
    let bannerSet = branding.banner_set;

    const avatarId = firstValue(values[idAvatar(ctx.guildId)]);
    if (avatarId !== undefined) {
      await ctx.deps.images.setAvatar(await readAndPrepare(ctx.deps, avatarId, "avatar"));
      avatarSet = true;
    }

    const bannerId = firstValue(values[idBanner(ctx.guildId)]);
    if (bannerId !== undefined) {
      await ctx.deps.images.setBanner(await readAndPrepare(ctx.deps, bannerId, "banner"));
      bannerSet = true;
    }

    const rawName = values[idName(ctx.guildId)];
    const name = boundedText(rawName, 32);
    let displayName = branding.display_name;
    if (name !== null && name !== branding.display_name) {
      await ctx.deps.images.setDisplayName(name);
      displayName = name;
    }

    return {
      branding: { display_name: displayName, avatar_set: avatarSet, banner_set: bannerSet },
    };
  },
};
