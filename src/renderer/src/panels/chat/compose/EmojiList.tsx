// One emoji picker shared by the composer, reactions and settings.
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import type { DirectoryGuild } from '@shared/contract';
import type { GuildEmoji } from '@shared/emoji';
import { DM_GUILD_ID } from '@shared/discord';
import { rankEmojiFavorites } from './emojiFavorites';
import { directory } from '@/state/directory';
import { inCompanion } from '@/state/ui';
import { expressionCatalog, frequentEmoji, loadUnicodeEmojiData, loaded, recentEmoji, recordEmojiPick, unicodeEmoji } from '@/state/expressions';
import { EmojiImage } from '@/ui/AnimatedImage';
import { errorText, tokenPx } from '@/ui/format';
import { GuildIcon } from '@/ui/GuildIcon';
import { Icon, type IconName } from '@/ui/icons';
import { sameIds } from '@plugin-sdk/renderer/settings';
import { CustomButton, UnicodeButton, emojisByGuild, frequentPicks, unicodeGroups, usableIn, type EmojiPick, type EmojiPreview, type OnPick } from './EmojiTab';
import { createGridStaging } from './gridStaging';
import { PickerSearch, PickerSection, StagedGrid, normalQuery } from './PickerParts';
import picker from './Picker.module.css';
import styles from './EmojiList.module.css';

const POPULAR = 'popular';
const FAVORITES = 'favorites';
const STANDARD = 'standard';

/** Popular in the channel's server, Discord favorites, servers in sidebar order, then system emoji. */
export function EmojiList(props: { guildId: string; onPick: OnPick }) {
  let body!: HTMLDivElement;
  let topGrid!: HTMLDivElement;
  const [query, setQuery] = createSignal('');
  const [current, setCurrent] = createSignal(POPULAR);
  const [hovered, setHovered] = createSignal<EmojiPreview>();
  onMount(loadUnicodeEmojiData);
  // The top sections open built; each server's and each system group's cells wait until scrolled near.
  const staging = createGridStaging(() => body, () => topGrid);
  const q =(): string => normalQuery(query());
  const catalog = () => loaded(expressionCatalog);
  const data = () => catalog()?.emojiPicker;
  const allByGuild = createMemo(() => emojisByGuild(''));
  const byGuild = createMemo(() => emojisByGuild(q()));
  // Key sections by ids: incoming directory refreshes must retain focused emoji and their images.
  const visibleGuildIds = createMemo(() => directory().map((g) => g.id), undefined, { equals: sameIds });
  const servers = () => visibleGuildIds().filter((id) => id !== DM_GUILD_ID && allByGuild().has(id));
  const matchingServers = () => servers().filter((id) => byGuild().has(id));
  const guild = (id: string) => directory().find((g) => g.id === id);
  const channelGuild = () => directory().find((g) => g.id === props.guildId);
  const groups = createMemo(() => unicodeGroups(q()));
  const customById = createMemo(() => {
    const visible = new Set(visibleGuildIds());
    return new Map((catalog()?.emojis ?? []).filter((e) => visible.has(e.guildId)).map((e) => [e.id, e]));
  });
  const unicodeByKey = createMemo(() => {
    const map = new Map<string, EmojiPreview>();
    for (const g of loaded(unicodeEmoji) ?? []) for (const e of g.emojis) {
      const preview = { pick: { unicode: e.emoji }, tag: e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label };
      map.set(e.emoji, preview);
      for (const shortcode of e.shortcodes) map.set(shortcode, preview);
    }
    return map;
  });
  // One preview per emoji, however often the lists are worked out again: they key their cells by it.
  const customPreviews = new WeakMap<GuildEmoji, EmojiPreview>();
  const plainPreviews = new Map<string, EmojiPreview>();
  const kept = <K,>(previews: { get(key: K): EmojiPreview | undefined; set(key: K, p: EmojiPreview): unknown }, key: K, pick: EmojiPick, tag: string): EmojiPreview => {
    const had = previews.get(key);
    if (had) return had;
    const made = { pick, tag };
    previews.set(key, made);
    return made;
  };
  const asPreview = (pick: EmojiPick): EmojiPreview => 'custom' in pick
    ? kept(customPreviews, pick.custom, pick, `:${pick.custom.name}:`)
    : unicodeByKey().get(pick.unicode) ?? kept(plainPreviews, pick.unicode, pick, pick.unicode);
  const matches = (p: EmojiPreview): boolean => {
    const pick = p.pick;
    return !q() || p.tag.toLowerCase().includes(q()) || ('unicode' in pick && (loaded(unicodeEmoji) ?? []).some((g) => g.emojis.some((e) => e.emoji === pick.unicode && e.search.includes(q()))));
  };
  const popular = createMemo(() => props.guildId === DM_GUILD_ID
    ? frequentPicks().map(asPreview).filter(matches)
    : (data()?.popular ?? []).flatMap((id) => {
      const e = customById().get(id);
      return e ? [asPreview({ custom: e })] : [];
    }).filter(matches));
  const favorites = createMemo(() => {
    const keyOf = (p: EmojiPreview): string => 'custom' in p.pick ? p.pick.custom.id : p.pick.unicode;
    const recent = recentEmoji();
    const frequent = frequentPicks().map((p) => 'custom' in p ? p.custom.id : p.unicode);
    const seen = new Set<string>();
    const picks = (data()?.favorites ?? []).flatMap((key) => {
      const e = customById().get(key);
      const p = e ? asPreview({ custom: e }) : unicodeByKey().get(key.replace(/^:|:$/g, ''));
      if (!p || seen.has(keyOf(p))) return [];
      seen.add(keyOf(p));
      return [p];
    });
    return rankEmojiFavorites(picks, keyOf, recent, frequent).filter(matches);
  });
  const firstPreview = (): EmojiPreview | undefined => {
    const first = popular()[0] ?? favorites()[0];
    if (first) return first;
    const emoji = byGuild().get(matchingServers()[0] ?? '')?.[0];
    if (emoji) return asPreview({ custom: emoji });
    const unicode = groups()[0]?.emojis[0];
    return unicode ? asPreview({ unicode: unicode.emoji }) : undefined;
  };
  const preview = () => hovered() ?? firstPreview();
  const previewCustom = () => {
    const pick = preview()?.pick;
    return pick && 'custom' in pick ? pick.custom : undefined;
  };
  const previewUnicode = () => {
    const pick = preview()?.pick;
    return pick && 'unicode' in pick ? pick.unicode : '';
  };
  const sourceGuild = () => directory().find((g) => g.id === previewCustom()?.guildId);
  const sourceName = () => sourceGuild()?.name ?? (previewCustom() ? 'Server emoji' : 'System emoji');
  const onPick: OnPick = (pick, keep) => {
    recordEmojiPick(pick);
    props.onPick(pick, keep);
  };

  /** Rects account for section margins and the search field; the rail tracks the section at the scrollport's top. */
  const track = (): void => {
    const top = body.getBoundingClientRect().top;
    const tolerance = tokenPx('--cp-border-w');
    let mark = '';
    for (const el of body.querySelectorAll<HTMLElement>('[data-bar]')) {
      if (el.getBoundingClientRect().top > top + tolerance) break;
      mark = el.dataset['bar']!;
    }
    setCurrent(mark || (body.querySelector<HTMLElement>('[data-bar]')?.dataset['bar'] ?? POPULAR));
  };
  const jump = (mark: string): void => {
    const el = [...body.querySelectorAll<HTMLElement>('[data-bar]')].find((e) => e.dataset['bar'] === mark);
    if (!el) return;
    body.scrollTop += el.getBoundingClientRect().top - body.getBoundingClientRect().top;
    setCurrent(mark);
  };
  const Mark = (p: { mark: string; label: string; icon?: IconName; guild?: DirectoryGuild; disabled?: boolean }) => (
    <button type="button" class={styles.mark} aria-label={p.label} title={p.label} aria-current={current() === p.mark} disabled={p.disabled} onClick={() => jump(p.mark)}>
      <Show when={p.guild} fallback={<Icon name={p.icon!} />}>
        {(g) => <GuildIcon id={g().id} name={g().name} icon={g().icon} />}
      </Show>
    </button>
  );
  const PickButton = (p: { preview: EmojiPreview }) => {
    const custom = () => 'custom' in p.preview.pick ? p.preview.pick.custom : undefined;
    const unicode = () => 'unicode' in p.preview.pick ? p.preview.pick.unicode : '';
    return <Show when={custom()} fallback={<UnicodeButton text={unicode()} title={p.preview.tag} onPick={onPick} onPreview={setHovered} />}>
      {(e) => <CustomButton emoji={e()} usable={usableIn(e(), props.guildId)} onPick={onPick} onPreview={setHovered} />}
    </Show>;
  };

  return (
    <div class={styles.root}>
      <div class={styles.main}>
        <nav class={styles.bar} aria-label="Emoji sections">
          <div class={styles.barScroll}>
            <Mark mark={POPULAR} label={props.guildId === DM_GUILD_ID ? 'Frequently used' : `Top emoji in ${channelGuild()?.name ?? 'this server'}`} icon="trophy" />
            <Mark mark={FAVORITES} label="Favorites" icon="star" />
            <div class={styles.divider} />
            <For each={servers()}>{(id) => <Mark mark={id} label={guild(id)?.name ?? 'Server'} guild={guild(id)} disabled={!byGuild().has(id)} />}</For>
            {/* The phone has no preview row, so its System mark ends the rail, as Discord's does. */}
            <Show when={inCompanion}><Mark mark={STANDARD} label="System emoji" icon="emoji" disabled={!groups().length} /></Show>
          </div>
        </nav>
        <div class={styles.content}>
          <PickerSearch label="Search emoji" value={query()} onInput={setQuery} />
          <div ref={body} class={`${picker.body} ${styles.list}`} onScroll={track}>
            <Show when={expressionCatalog.error ?? frequentEmoji.error ?? unicodeEmoji.error}>{(err) => <p class="cp-error">Couldn't load emoji: {errorText(err())}</p>}</Show>
            <PickerSection title={props.guildId === DM_GUILD_ID ? 'Frequently used' : `Top emoji in ${channelGuild()?.name ?? 'this server'}`} bar={POPULAR} icon="trophy">
              <div ref={topGrid} class={picker.emojiGrid}><For each={popular()}>{(p) => <PickButton preview={p} />}</For></div>
              <Show when={!popular().length}>
                <p class={styles.empty}>{data()?.popularError ? "Couldn't load this server's top emoji." : expressionCatalog.loading ? 'Loading top emoji…' : q() ? 'No top emoji match your search.' : 'No top emoji available yet.'}</p>
              </Show>
            </PickerSection>
            <PickerSection title="Favorites" bar={FAVORITES} icon="star">
              <div class={picker.emojiGrid}><For each={favorites()}>{(p) => <PickButton preview={p} />}</For></div>
              <Show when={!favorites().length}>
                <p class={styles.empty}>{data()?.favoritesError ? "Couldn't load Discord favorites. Reopen to retry." : expressionCatalog.loading || unicodeEmoji.loading ? 'Loading favorites…' : q() ? 'No favorites match your search.' : 'Emoji you favorite in Discord appear here.'}</p>
              </Show>
            </PickerSection>
            <For each={matchingServers()}>
              {(id) => (
                <PickerSection title={guild(id)?.name ?? 'Server'} bar={id}>
                  <StagedGrid staging={staging} items={byGuild().get(id)}>
                    {(e) => <CustomButton emoji={e} usable={usableIn(e, props.guildId)} onPick={onPick} onPreview={setHovered} />}
                  </StagedGrid>
                </PickerSection>
              )}
            </For>
            <For each={groups()}>
              {(g, i) => (
                <PickerSection title={g.name} bar={i() === 0 ? STANDARD : undefined}>
                  <StagedGrid staging={staging} items={g.emojis}>
                    {(e) => <UnicodeButton text={e.emoji} title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onPick={onPick} onPreview={setHovered} />}
                  </StagedGrid>
                </PickerSection>
              )}
            </For>
            <Show when={q() && !popular().length && !favorites().length && !matchingServers().length && !groups().length && !expressionCatalog.loading && !unicodeEmoji.loading}>
              <p class="cp-panel-empty">No emoji match “{query()}”.</p>
            </Show>
          </div>
        </div>
      </div>
      {/* A preview follows the pointer: a phone has none, and the row's height goes to the list. */}
      <Show when={!inCompanion}>
        <div class={styles.preview} aria-label="Emoji preview">
          <nav class={styles.systemMark} aria-label="System emoji section">
            <Mark mark={STANDARD} label="System emoji" icon="emoji" disabled={!groups().length} />
          </nav>
          <Show when={preview()} fallback={<span class={styles.hint}>Hover an emoji to preview</span>}>
            {(p) => <>
              <div class={styles.previewGlyph}>
                <Show when={previewCustom()} fallback={<span>{previewUnicode()}</span>}>
                  {(e) => <EmojiImage class={styles.previewImage} emoji={e()} alt={p().tag} />}
                </Show>
              </div>
              <div class={styles.previewText}>
                <strong class={styles.previewTag} title={p().tag}>{p().tag}</strong>
                <span class={styles.hint}>{previewCustom() && !usableIn(previewCustom()!, props.guildId) ? 'Needs Nitro here' : 'Emoji preview'}</span>
              </div>
              <div class={styles.source} title={sourceName()}>
                <span>{sourceName()}</span>
                <Show when={sourceGuild()} fallback={<Icon name="emoji" />}>
                  {(g) => <GuildIcon id={g().id} name={g().name} icon={g().icon} />}
                </Show>
              </div>
            </>}
          </Show>
        </div>
      </Show>
    </div>
  );
}
