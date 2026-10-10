import { For, Show, createSignal, onMount } from 'solid-js';
import { canUseEmoji } from '@shared/compose';
import type { GuildEmoji } from '@shared/emoji';
import { EmojiImage } from '@/ui/AnimatedImage';
import { expressionCatalog, frequentEmoji, loadUnicodeEmojiData, loaded, unicodeEmoji, type UnicodeGroup } from '@/state/expressions';
import { errorText } from '@/ui/format';
import type { SeenLoading } from '@/ui/seenLoading';
import { PickerSearch, PickerSection, normalQuery } from './PickerParts';
import styles from './Picker.module.css';
import { EmojiList } from './EmojiList';

/** A pick: Unicode emoji text, or a custom emoji. */
export type EmojiPick = { unicode: string } | { custom: GuildEmoji };

/** Every server's custom emoji matching `q` (a normalQuery), by server. */
export function emojisByGuild(q: string): Map<string, GuildEmoji[]> {
  const map = new Map<string, GuildEmoji[]>();
  for (const e of loaded(expressionCatalog)?.emojis ?? []) {
    if (q && !e.name.toLowerCase().includes(q)) continue;
    const list = map.get(e.guildId);
    if (list) list.push(e);
    else map.set(e.guildId, [e]);
  }
  return map;
}

/** Whether the owner's plan lets them use `e` in a channel of `guildId`. */
export const usableIn = (e: GuildEmoji, guildId: string): boolean => {
  const perks = loaded(expressionCatalog)?.perks;
  return !!perks && canUseEmoji(e, guildId, perks);
};

/** The owner's most-used emoji; a custom one shows only while a server still has it (its server decides usability). */
export function frequentPicks(): EmojiPick[] {
  const byId = new Map((loaded(expressionCatalog)?.emojis ?? []).map((e) => [e.id, e]));
  return (loaded(frequentEmoji) ?? []).flatMap((f): EmojiPick[] => {
    if ('unicode' in f) return [f];
    const e = byId.get(f.custom.id);
    return e ? [{ custom: e }] : [];
  });
}

/** Unicode emoji groups (those this machine can draw) with the emoji matching `q` (a normalQuery); empty groups left out. */
export const unicodeGroups = (q: string): UnicodeGroup[] =>
  (loaded(unicodeEmoji) ?? []).map((g) => ({ ...g, emojis: g.emojis.filter((e) => !q || e.search.includes(q)) })).filter((g) => g.emojis.length);

/** The composer's emoji view shares the section rail and preview with the reaction picker. */
export function ServerEmojiTab(props: { guildId: string; onPick: OnPick }) {
  return <EmojiList guildId={props.guildId} onPick={props.onPick} />;
}
/** The System tab: Unicode emoji by group (those this machine can draw); search matches names, tags and shortcodes. */
export function SystemEmojiTab(props: { onPick: OnPick }) {
  const [query, setQuery] = createSignal('');
  onMount(loadUnicodeEmojiData);
  const groups = () => unicodeGroups(normalQuery(query()));

  return (
    <>
      <PickerSearch label="Search system emoji" value={query()} onInput={setQuery} />
      <div class={styles.body}>
        <Show when={unicodeEmoji.error}>{(err) => <p class="cp-error">Couldn't load emoji: {errorText(err())}</p>}</Show>
        <For each={groups()}>
          {(g) => (
            <PickerSection title={g.name}>
              <div class={styles.emojiGrid}>
                <For each={g.emojis}>{(e) => <UnicodeButton text={e.emoji} title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onPick={props.onPick} />}</For>
              </div>
            </PickerSection>
          )}
        </For>
        <Show when={query() && !groups().length && !unicodeEmoji.loading}>
          <p class="cp-panel-empty">No emoji match “{query()}”.</p>
        </Show>
      </div>
    </>
  );
}

export type OnPick = (pick: EmojiPick, keep: boolean) => void;

export type EmojiPreview = { pick: EmojiPick; tag: string };

/** `whenSeen`: in a long list, the picture waits until it can be seen (SeenLoading). */
export function CustomButton(props: { emoji: GuildEmoji; usable: boolean; onPick: OnPick; onPreview?: (preview: EmojiPreview) => void; whenSeen?: SeenLoading['whenSeen'] }) {
  const preview = (): void => props.onPreview?.({ pick: { custom: props.emoji }, tag: `:${props.emoji.name}:` });
  return (
    <button
      type="button"
      class={styles.emoji}
      disabled={!props.usable}
      title={props.usable ? `:${props.emoji.name}:` : `:${props.emoji.name}: · needs Nitro here`}
      onPointerEnter={preview}
      onFocus={preview}
      onClick={(ev) => props.onPick({ custom: props.emoji }, ev.shiftKey)}
    >
      <EmojiImage class={styles.emojiImg} emoji={props.emoji} alt={`:${props.emoji.name}:`} loading={props.whenSeen ? undefined : 'lazy'} whenSeen={props.whenSeen} />
    </button>
  );
}

export function UnicodeButton(props: { text: string; title: string; onPick: OnPick; onPreview?: (preview: EmojiPreview) => void }) {
  const preview = (): void => props.onPreview?.({ pick: { unicode: props.text }, tag: props.title });
  return (
    <button type="button" class={styles.emoji} title={props.title} onPointerEnter={preview} onFocus={preview} onClick={(ev) => props.onPick({ unicode: props.text }, ev.shiftKey)}>
      <span class={styles.emojiChar}>{props.text}</span>
    </button>
  );
}
