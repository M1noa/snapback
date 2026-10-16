// plain-object factories for action rows and every interactive control, plus the
// customID build/parse pair (D4PLAN 9.1, 9.3). camelCase keys only; snake_case is
// the raw wire format and never appears here.

import {
  type ButtonComponent,
  ButtonStyles,
  type ChannelSelectMenu,
  type ChannelTypes,
  type CheckboxComponent,
  type CheckboxGroupComponent,
  type CheckboxGroupOption,
  ComponentTypes,
  type FilterFileTypes,
  type MentionableSelectMenu,
  type MessageActionRow,
  type MessageActionRowComponent,
  type ModalComponent,
  type ModalFileUploadComponent,
  type ModalLabel,
  type ModalLabelComponent,
  type NullablePartialEmoji,
  type RadioGroupComponent,
  type RadioGroupOption,
  type RoleSelectMenu,
  type SelectOption,
  type StringSelectMenu,
  type TextInput,
  TextInputStyles,
  type UserSelectMenu,
} from "oceanic.js";

export function actionRow(components: MessageActionRowComponent[]): MessageActionRow {
  return { type: ComponentTypes.ACTION_ROW, components };
}

export interface ButtonOptions {
  style: ButtonStyles;
  id?: string; // customID for the interactive styles
  label?: string;
  emoji?: NullablePartialEmoji;
  disabled?: boolean;
  url?: string; // style LINK
  skuID?: string; // style PREMIUM
}

export function button(opts: ButtonOptions): ButtonComponent {
  const { style, id, label, emoji, disabled, url, skuID } = opts;
  if (style === ButtonStyles.LINK) {
    if (!url) throw new Error("button: a link button needs a url");
    return { type: ComponentTypes.BUTTON, style, url, label, emoji, disabled };
  }
  if (style === ButtonStyles.PREMIUM) {
    if (!skuID) throw new Error("button: a premium button needs a skuID");
    return { type: ComponentTypes.BUTTON, style, skuID, disabled };
  }
  if (!id) throw new Error("button: an interactive button needs a customID");
  return { type: ComponentTypes.BUTTON, style, customID: id, label, emoji, disabled };
}

export interface SelectOptions {
  id: string;
  placeholder?: string;
  minValues?: number;
  maxValues?: number;
  disabled?: boolean;
}

export interface StringSelectOptions extends SelectOptions {
  options: SelectOption[];
}

export function stringSelect(opts: StringSelectOptions): StringSelectMenu {
  return {
    type: ComponentTypes.STRING_SELECT,
    customID: opts.id,
    placeholder: opts.placeholder,
    options: opts.options,
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    disabled: opts.disabled,
  };
}

export function userSelect(opts: SelectOptions): UserSelectMenu {
  return {
    type: ComponentTypes.USER_SELECT,
    customID: opts.id,
    placeholder: opts.placeholder,
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    disabled: opts.disabled,
  };
}

export function roleSelect(opts: SelectOptions): RoleSelectMenu {
  return {
    type: ComponentTypes.ROLE_SELECT,
    customID: opts.id,
    placeholder: opts.placeholder,
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    disabled: opts.disabled,
  };
}

export function mentionableSelect(opts: SelectOptions): MentionableSelectMenu {
  return {
    type: ComponentTypes.MENTIONABLE_SELECT,
    customID: opts.id,
    placeholder: opts.placeholder,
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    disabled: opts.disabled,
  };
}

export interface ChannelSelectOptions extends SelectOptions {
  channelTypes?: ChannelTypes[];
}

export function channelSelect(opts: ChannelSelectOptions): ChannelSelectMenu {
  // channelTypes is optional to us but required on the library's type; undefined
  // is dropped at serialization, which discord reads as "all channel types".
  return {
    type: ComponentTypes.CHANNEL_SELECT,
    customID: opts.id,
    placeholder: opts.placeholder,
    channelTypes: opts.channelTypes as ChannelTypes[],
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    disabled: opts.disabled,
  };
}

export interface LabelOptions {
  label: string;
  description?: string;
  component: ModalLabelComponent;
}

// a modal label. only a label or a text display may sit at the top of a modal.
export function label(opts: LabelOptions): ModalLabel {
  return {
    type: ComponentTypes.LABEL,
    label: opts.label,
    description: opts.description,
    component: opts.component,
  };
}

export interface TextInputOptions {
  id: string;
  style?: TextInputStyles;
  label?: string;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  required?: boolean;
  value?: string;
}

export function textInput(opts: TextInputOptions): TextInput {
  return {
    type: ComponentTypes.TEXT_INPUT,
    customID: opts.id,
    style: opts.style ?? TextInputStyles.SHORT,
    label: opts.label,
    placeholder: opts.placeholder,
    minLength: opts.minLength,
    maxLength: opts.maxLength,
    required: opts.required,
    value: opts.value,
  };
}

export interface FileUploadOptions {
  id: string;
  minValues?: number;
  maxValues?: number;
  required?: boolean;
  fileTypes?: FilterFileTypes[];
}

export function fileUpload(opts: FileUploadOptions): ModalFileUploadComponent {
  return {
    type: ComponentTypes.FILE_UPLOAD,
    customID: opts.id,
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    required: opts.required,
    fileTypes: opts.fileTypes,
  };
}

export interface CheckboxOptions {
  id: string;
  default?: boolean;
}

export function checkbox(opts: CheckboxOptions): CheckboxComponent {
  return { type: ComponentTypes.CHECKBOX, customID: opts.id, default: opts.default };
}

export interface CheckboxGroupOptions {
  id: string;
  options: CheckboxGroupOption[];
  minValues?: number;
  maxValues?: number;
  required?: boolean;
}

export function checkboxGroup(opts: CheckboxGroupOptions): CheckboxGroupComponent {
  return {
    type: ComponentTypes.CHECKBOX_GROUP,
    customID: opts.id,
    options: opts.options,
    minValues: opts.minValues,
    maxValues: opts.maxValues,
    required: opts.required,
  };
}

export interface RadioGroupOptions {
  id: string;
  options: RadioGroupOption[];
  required?: boolean;
}

export function radioGroup(opts: RadioGroupOptions): RadioGroupComponent {
  return {
    type: ComponentTypes.RADIO_GROUP,
    customID: opts.id,
    options: opts.options,
    required: opts.required,
  };
}

export interface ModalOptions {
  id: string;
  title: string;
  components: ModalComponent[];
}

// the modal interaction response body, not a message component. carries the
// labels it was given.
export function modal(opts: ModalOptions): {
  customID: string;
  title: string;
  components: ModalComponent[];
} {
  return { customID: opts.id, title: opts.title, components: opts.components };
}

// customID namespace: sb:<surface>:<guild>:<object>:<action>:<cursor> (D4PLAN
// 9.3). a selection payload never goes in here; it belongs in interaction_state
// keyed by a short random cursor.

const PREFIX = "sb";
const SEP = ":";
const MAX_LENGTH = 100; // discord's customID limit
// a token may not contain the separator or a control character, or it would not
// round-trip. letters, digits, dash, underscore only.
const TOKEN = /^[a-z0-9_-]+$/i;

export interface CustomIDParts {
  surface: string;
  guild: string;
  object: string;
  action: string;
  cursor?: string;
}

export function customID(parts: CustomIDParts): string {
  const fields = [parts.surface, parts.guild, parts.object, parts.action];
  for (const field of fields) {
    if (!TOKEN.test(field)) throw new Error(`customID: bad token "${field}"`);
  }
  if (parts.cursor !== undefined && !TOKEN.test(parts.cursor)) {
    throw new Error(`customID: bad cursor "${parts.cursor}"`);
  }
  const id = [PREFIX, ...fields, ...(parts.cursor === undefined ? [] : [parts.cursor])].join(SEP);
  if (id.length > MAX_LENGTH) throw new Error(`customID: ${id.length} chars exceeds ${MAX_LENGTH}`);
  return id;
}

// null on anything that is not a well-formed id, so a handler can answer an old
// button with an "older version" page instead of throwing (D4PLAN 9.6).
export function parseCustomID(id: string): CustomIDParts | null {
  const parts = id.split(SEP);
  if (parts[0] !== PREFIX) return null;
  if (parts.length !== 5 && parts.length !== 6) return null;
  const surface = parts[1];
  const guild = parts[2];
  const object = parts[3];
  const action = parts[4];
  const cursor = parts[5];
  if (surface === undefined || !TOKEN.test(surface)) return null;
  if (guild === undefined || !TOKEN.test(guild)) return null;
  if (object === undefined || !TOKEN.test(object)) return null;
  if (action === undefined || !TOKEN.test(action)) return null;
  if (cursor !== undefined && !TOKEN.test(cursor)) return null;
  return { surface, guild, object, action, ...(cursor === undefined ? {} : { cursor }) };
}
