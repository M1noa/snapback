// plain-object factories for the non-interactive v2 content components. no
// classes, no builders: oceanic has none, and this is the confirmed shape
// (D4PLAN 9.1). every factory returns a raw camelCase object the library sends
// as-is.

import {
  type ButtonComponent,
  ComponentTypes,
  type FileComponent,
  type MediaGalleryComponent,
  type MediaGalleryItem,
  type SectionComponent,
  type SeparatorComponent,
  SeparatorSpacingSize,
  type TextDisplayComponent,
  type ThumbnailComponent,
} from "oceanic.js";

// markdown text. a section holds one to three of these.
export function textDisplay(content: string): TextDisplayComponent {
  return { type: ComponentTypes.TEXT_DISPLAY, content };
}

export interface SeparatorOptions {
  divider?: boolean;
  spacing?: SeparatorSpacingSize;
}

export function separator(opts: SeparatorOptions = {}): SeparatorComponent {
  return {
    type: ComponentTypes.SEPARATOR,
    divider: opts.divider ?? true,
    spacing: opts.spacing ?? SeparatorSpacingSize.SMALL,
  };
}

export interface ImageOptions {
  description?: string | null;
  spoiler?: boolean;
}

// small image used as a section accessory. url may be an attachment:// reference.
export function thumbnail(url: string, opts: ImageOptions = {}): ThumbnailComponent {
  return {
    type: ComponentTypes.THUMBNAIL,
    media: { url },
    description: opts.description ?? null,
    spoiler: opts.spoiler,
  };
}

export interface MediaItem {
  url: string;
  description?: string | null;
  spoiler?: boolean;
}

export function mediaGallery(items: MediaItem[]): MediaGalleryComponent {
  const mapped: MediaGalleryItem[] = items.map((item) => ({
    media: { url: item.url },
    description: item.description ?? null,
    spoiler: item.spoiler,
  }));
  return { type: ComponentTypes.MEDIA_GALLERY, items: mapped };
}

// a full file attachment. discord only accepts attachment://<filename> here, not
// an arbitrary url, so the caller must attach the file and pass its name.
export function file(url: string, opts: ImageOptions = {}): FileComponent {
  return { type: ComponentTypes.FILE, file: { url }, spoiler: opts.spoiler };
}

export type SectionAccessory = ThumbnailComponent | ButtonComponent;

export interface SectionOptions {
  texts: TextDisplayComponent[];
  accessory: SectionAccessory;
}

// one to three text displays plus exactly one accessory (thumbnail or button).
export function section(opts: SectionOptions): SectionComponent {
  const { texts, accessory } = opts;
  if (texts.length < 1 || texts.length > 3) {
    throw new Error(`section: needs 1-3 text displays, got ${texts.length}`);
  }
  if (accessory.type !== ComponentTypes.THUMBNAIL && accessory.type !== ComponentTypes.BUTTON) {
    throw new Error("section: accessory must be a thumbnail or a button");
  }
  return { type: ComponentTypes.SECTION, components: texts, accessory };
}
