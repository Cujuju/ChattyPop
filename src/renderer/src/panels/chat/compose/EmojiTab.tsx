import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { canUseEmoji } from '@shared/compose';
import { emojiUrl, type GuildEmoji } from '@shared/emoji';
import { directory } from '@/state/directory';
import { expressionCatalog, frequentEmoji, loadUnicodeEmojiData, loaded, unicodeEmoji, type UnicodeGroup } from '@/state/expressions';
import { errorText } from '@/ui/format';
import { PickerSearch, PickerSection, guildOrder, normalQuery } from './PickerParts';
import styles from './Picker.module.css';

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

/** Emoji tab lists frequent emoji then custom servers, channel server first. Unusable emoji disable; shift keeps picker open. */
export function ServerEmojiTab(props: { guildId: string; onPick: OnPick }) {
  const [query, setQuery] = createSignal('');
  const byGuild = createMemo(() => emojisByGuild(normalQuery(query())));
  /** Keys servers by ids to retain images across directory object refreshes. */
  const customGuilds = (): string[] => guildOrder(props.guildId).filter((id) => byGuild().has(id));
  const guildName = (id: string): string => directory().find((g) => g.id === id)?.name ?? 'Server';
  const usable = (e: GuildEmoji): boolean => usableIn(e, props.guildId);
  const frequent = frequentPicks;

  return (
    <>
      <PickerSearch label="Search emoji" value={query()} onInput={setQuery} />
      <div class={styles.body}>
        <Show when={expressionCatalog.error ?? frequentEmoji.error}>{(err) => <p class="cp-error">Couldn't load emoji: {errorText(err())}</p>}</Show>
        <Show when={!query() && frequent().length}>
          <PickerSection title="Frequently used">
            <div class={styles.emojiGrid}>
              <For each={frequent()}>
                {(f) => ('custom' in f ? <CustomButton emoji={f.custom} usable={usable(f.custom)} onPick={props.onPick} /> : <UnicodeButton text={f.unicode} title={f.unicode} onPick={props.onPick} />)}
              </For>
            </div>
          </PickerSection>
        </Show>
        <For each={customGuilds()}>
          {(guildId) => (
            <PickerSection title={guildName(guildId)}>
              <div class={styles.emojiGrid}>
                <For each={byGuild().get(guildId)}>{(e) => <CustomButton emoji={e} usable={usable(e)} onPick={props.onPick} />}</For>
              </div>
            </PickerSection>
          )}
        </For>
        <Show when={!expressionCatalog.loading && !customGuilds().length}>
          <p class="cp-panel-empty">{query() ? `No server emoji match “${query()}”.` : 'No server emoji yet.'}</p>
        </Show>
      </div>
    </>
  );
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

export function CustomButton(props: { emoji: GuildEmoji; usable: boolean; onPick: OnPick }) {
  return (
    <button
      type="button"
      class={styles.emoji}
      disabled={!props.usable}
      title={props.usable ? `:${props.emoji.name}:` : `:${props.emoji.name}: · needs Nitro here`}
      onClick={(ev) => props.onPick({ custom: props.emoji }, ev.shiftKey)}
    >
      <img class={styles.emojiImg} src={emojiUrl(props.emoji)} alt={`:${props.emoji.name}:`} loading="lazy" />
    </button>
  );
}

export function UnicodeButton(props: { text: string; title: string; onPick: OnPick }) {
  return (
    <button type="button" class={styles.emoji} title={props.title} onClick={(ev) => props.onPick({ unicode: props.text }, ev.shiftKey)}>
      <span class={styles.emojiChar}>{props.text}</span>
    </button>
  );
}
