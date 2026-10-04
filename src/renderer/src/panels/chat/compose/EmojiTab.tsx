import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import { canUseEmoji } from '@shared/compose';
import { emojiUrl, type GuildEmoji } from '@shared/emoji';
import { directory } from '@/state/directory';
import { expressionCatalog, frequentEmoji, loadUnicodeEmojiData, loaded, unicodeEmoji } from '@/state/expressions';
import { errorText } from '@/ui/format';
import { PickerSearch, PickerSection, guildOrder, normalQuery } from './PickerParts';
import styles from './Picker.module.css';

/** A pick: Unicode emoji text, or a custom emoji. */
export type EmojiPick = { unicode: string } | { custom: GuildEmoji };

/**
 * The Emoji tab: the owner's frequently used emoji (hidden while searching), then every server's custom emoji (this
 * channel's server first). Emoji the plan can't send here show disabled. `keep` in onPick: shift was held, so the
 * picker stays open (as in Discord).
 */
export function ServerEmojiTab(props: { guildId: string; onPick: OnPick }) {
  const [query, setQuery] = createSignal('');
  const emojis = (): GuildEmoji[] => loaded(expressionCatalog)?.emojis ?? [];

  /** Matching emoji by server. */
  const byGuild = createMemo((): Map<string, GuildEmoji[]> => {
    const q = normalQuery(query());
    const map = new Map<string, GuildEmoji[]>();
    for (const e of emojis()) {
      if (q && !e.name.toLowerCase().includes(q)) continue;
      const list = map.get(e.guildId);
      if (list) list.push(e);
      else map.set(e.guildId, [e]);
    }
    return map;
  });
  /** Server ids, not group objects: <For> keys by identity, so new objects each directory refetch would rebuild every image. */
  const customGuilds = (): string[] => guildOrder(props.guildId).filter((id) => byGuild().has(id));
  const guildName = (id: string): string => directory().find((g) => g.id === id)?.name ?? 'Server';
  const usable = (e: GuildEmoji): boolean => {
    const perks = loaded(expressionCatalog)?.perks;
    return !!perks && canUseEmoji(e, props.guildId, perks);
  };
  /** The owner's most-used emoji; a custom one shows only while a server still has it (its server decides usability). */
  const frequent = (): EmojiPick[] => {
    const byId = new Map(emojis().map((e) => [e.id, e]));
    return (loaded(frequentEmoji) ?? []).flatMap((f): EmojiPick[] => {
      if ('unicode' in f) return [f];
      const e = byId.get(f.custom.id);
      return e ? [{ custom: e }] : [];
    });
  };

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
  const groups = () => {
    const q = normalQuery(query());
    return (loaded(unicodeEmoji) ?? []).map((g) => ({ ...g, emojis: g.emojis.filter((e) => !q || e.search.includes(q)) })).filter((g) => g.emojis.length);
  };

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

type OnPick = (pick: EmojiPick, keep: boolean) => void;

function CustomButton(props: { emoji: GuildEmoji; usable: boolean; onPick: OnPick }) {
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

function UnicodeButton(props: { text: string; title: string; onPick: OnPick }) {
  return (
    <button type="button" class={styles.emoji} title={props.title} onClick={(ev) => props.onPick({ unicode: props.text }, ev.shiftKey)}>
      <span class={styles.emojiChar}>{props.text}</span>
    </button>
  );
}
