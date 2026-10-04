// Discord message components (buttons, select menus, and the layout blocks of component-only messages), read from payloads.
import type { ModalField } from './commands';
import { mediaSize } from './media';
import type { MediaSize } from './types/archive';

/** Discord's component type numbers. */
export const COMPONENT = {
  row: 1,
  button: 2,
  stringSelect: 3,
  textInput: 4,
  userSelect: 5,
  roleSelect: 6,
  mentionableSelect: 7,
  channelSelect: 8,
  section: 9,
  textDisplay: 10,
  thumbnail: 11,
  gallery: 12,
  file: 13,
  separator: 14,
  container: 17,
  label: 18,
} as const;

/** Button styles; link buttons open a URL instead of reaching the bot, premium ones open Discord's shop. */
export const BUTTON_STYLE = { primary: 1, secondary: 2, success: 3, danger: 4, link: 5, premium: 6 } as const;

/** Message flags ChattyPop reads. */
export const MESSAGE_FLAG = {
  /** Only the person who used the command sees it. */
  ephemeral: 1 << 6,
  /** The bot deferred its answer ("is thinking…"). */
  loading: 1 << 7,
} as const;

/** Discord's separator spacing value for a large gap. */
const SEPARATOR_LARGE = 2;

export type SelectKind = 'string' | 'user' | 'role' | 'mentionable' | 'channel';
const SELECT_KINDS: Record<number, SelectKind> = {
  [COMPONENT.stringSelect]: 'string',
  [COMPONENT.userSelect]: 'user',
  [COMPONENT.roleSelect]: 'role',
  [COMPONENT.mentionableSelect]: 'mentionable',
  [COMPONENT.channelSelect]: 'channel',
};

export interface ComponentEmoji {
  id: string | null;
  name: string;
  animated: boolean;
}

export interface SelectOption {
  label: string;
  value: string;
  description: string | null;
  emoji: ComponentEmoji | null;
  selected: boolean;
}

export interface MediaItem {
  url: string;
  description: string | null;
  size: MediaSize | null;
}

export type MessageComponent =
  | { type: 'row'; children: MessageComponent[] }
  | { type: 'button'; style: number; label: string | null; emoji: ComponentEmoji | null; customId: string | null; url: string | null; disabled: boolean }
  | {
      type: 'select';
      kind: SelectKind;
      componentType: number;
      customId: string;
      placeholder: string | null;
      minValues: number;
      maxValues: number;
      disabled: boolean;
      options: SelectOption[];
      channelTypes: number[];
    }
  | { type: 'text'; content: string }
  | { type: 'section'; children: MessageComponent[]; accessory: MessageComponent | null }
  | { type: 'thumbnail'; media: MediaItem }
  | { type: 'gallery'; items: MediaItem[] }
  | { type: 'file'; url: string; name: string }
  | { type: 'separator'; divider: boolean; large: boolean }
  | { type: 'container'; color: number | null; children: MessageComponent[] };

type Raw = Record<string, unknown>;

const isObj = (v: unknown): v is Raw => typeof v === 'object' && v !== null && !Array.isArray(v);
const list = (v: unknown): Raw[] => (Array.isArray(v) ? v.filter(isObj) : []);
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null);
const num = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
const numOrNull = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function emoji(v: unknown): ComponentEmoji | null {
  if (!isObj(v) || !text(v['name'])) return null;
  return { id: text(v['id']), name: v['name'] as string, animated: v['animated'] === true };
}

/** A media reference: Discord's proxy copy when it made one, else the original. */
function media(v: unknown): MediaItem | null {
  const m = isObj(v) && isObj(v['media']) ? v['media'] : null;
  const url = m ? (text(m['proxy_url']) ?? text(m['url'])) : null;
  return url ? { url, description: isObj(v) ? text(v['description']) : null, size: mediaSize(m) } : null;
}

function selectOptions(v: unknown): SelectOption[] {
  return list(v).flatMap((o) =>
    text(o['label']) !== null && typeof o['value'] === 'string'
      ? [{ label: o['label'] as string, value: o['value'], description: text(o['description']), emoji: emoji(o['emoji']), selected: o['default'] === true }]
      : [],
  );
}

function component(c: Raw): MessageComponent | null {
  const type = num(c['type'], 0);
  const kind = SELECT_KINDS[type];
  if (kind) {
    return {
      type: 'select',
      kind,
      componentType: type,
      customId: text(c['custom_id']) ?? '',
      placeholder: text(c['placeholder']),
      minValues: num(c['min_values'], 1),
      maxValues: num(c['max_values'], 1),
      disabled: c['disabled'] === true,
      options: selectOptions(c['options']),
      channelTypes: Array.isArray(c['channel_types']) ? c['channel_types'].filter((t): t is number => typeof t === 'number') : [],
    };
  }
  switch (type) {
    case COMPONENT.row:
      return { type: 'row', children: componentsFrom(c['components']) };
    case COMPONENT.button:
      return { type: 'button', style: num(c['style'], BUTTON_STYLE.secondary), label: text(c['label']), emoji: emoji(c['emoji']), customId: text(c['custom_id']), url: text(c['url']), disabled: c['disabled'] === true };
    case COMPONENT.textDisplay:
      return { type: 'text', content: text(c['content']) ?? '' };
    case COMPONENT.section: {
      const accessory = isObj(c['accessory']) ? component(c['accessory']) : null;
      return { type: 'section', children: componentsFrom(c['components']), accessory };
    }
    case COMPONENT.thumbnail: {
      const m = media(c);
      return m ? { type: 'thumbnail', media: m } : null;
    }
    case COMPONENT.gallery:
      return { type: 'gallery', items: list(c['items']).flatMap((i) => media(i) ?? []) };
    case COMPONENT.file: {
      const f = isObj(c['file']) ? c['file'] : {};
      const url = text(f['proxy_url']) ?? text(f['url']);
      return url ? { type: 'file', url, name: text(c['name']) ?? url.split('/').pop()!.split('?')[0]! } : null;
    }
    case COMPONENT.separator:
      return { type: 'separator', divider: c['divider'] !== false, large: c['spacing'] === SEPARATOR_LARGE };
    case COMPONENT.container:
      return { type: 'container', color: numOrNull(c['accent_color']), children: componentsFrom(c['components']) };
    default:
      return null; // a kind ChattyPop doesn't draw
  }
}

/** A message's `components` as ChattyPop draws them; unknown kinds are left out. */
export function componentsFrom(raw: unknown): MessageComponent[] {
  return list(raw).flatMap((c) => component(c) ?? []);
}

function modalField(c: Raw, wrap: 'row' | 'label', label: string | null, description: string | null): ModalField | null {
  const type = num(c['type'], 0);
  if (type === COMPONENT.textInput) {
    return {
      kind: 'text',
      wrap,
      customId: text(c['custom_id']) ?? '',
      label: label ?? text(c['label']) ?? '',
      description,
      paragraph: c['style'] === 2,
      placeholder: text(c['placeholder']),
      value: text(c['value']) ?? '',
      required: c['required'] !== false,
      minLength: numOrNull(c['min_length']),
      maxLength: numOrNull(c['max_length']),
    };
  }
  if (type === COMPONENT.stringSelect) {
    return {
      kind: 'select',
      wrap,
      customId: text(c['custom_id']) ?? '',
      label: label ?? '',
      description,
      placeholder: text(c['placeholder']),
      required: c['required'] !== false,
      minValues: num(c['min_values'], 1),
      maxValues: num(c['max_values'], 1),
      options: selectOptions(c['options']).map(({ emoji: _e, ...o }) => o),
    };
  }
  return null;
}

/** A bot form's fields: text inputs and menus (bare in a row, or under a label) and its text blocks; others are left out. */
export function modalFieldsFrom(raw: unknown): ModalField[] {
  return list(raw).flatMap((c): ModalField[] => {
    const type = num(c['type'], 0);
    if (type === COMPONENT.textDisplay) return [{ kind: 'info', content: text(c['content']) ?? '' }];
    if (type === COMPONENT.label && isObj(c['component'])) return [modalField(c['component'], 'label', text(c['label']), text(c['description']))].filter((f) => f !== null);
    if (type === COMPONENT.row) return list(c['components']).flatMap((i) => modalField(i, 'row', null, null) ?? []);
    return [];
  });
}

/** A form's answers, nested as Discord nested its fields. */
export function modalSubmission(fields: ModalField[], values: Record<string, string | string[]>): Raw[] {
  return fields.flatMap((f): Raw[] => {
    if (f.kind === 'info') return [];
    const v = values[f.customId];
    const inner =
      f.kind === 'text'
        ? { type: COMPONENT.textInput, custom_id: f.customId, value: typeof v === 'string' ? v : '' }
        : { type: COMPONENT.stringSelect, custom_id: f.customId, values: Array.isArray(v) ? v : [] };
    return [f.wrap === 'label' ? { type: COMPONENT.label, component: inner } : { type: COMPONENT.row, components: [inner] }];
  });
}
