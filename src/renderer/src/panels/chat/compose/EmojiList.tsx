// The reaction picker's emoji, laid out as Discord's: one scrolling list and a bar of section marks.
import { For, Show, createMemo, createSignal, onMount } from 'solid-js';
import type { DirectoryGuild } from '@shared/contract';
import { directory } from '@/state/directory';
import { expressionCatalog, frequentEmoji, loadUnicodeEmojiData, unicodeEmoji } from '@/state/expressions';
import { errorText } from '@/ui/format';
import { GuildIcon } from '@/ui/GuildIcon';
import { Icon, type IconName } from '@/ui/icons';
import { CustomButton, UnicodeButton, emojisByGuild, frequentPicks, unicodeGroups, usableIn, type OnPick } from './EmojiTab';
import { PickerSearch, PickerSection, normalQuery } from './PickerParts';
import picker from './Picker.module.css';
import styles from './EmojiList.module.css';

/** Section bar marks that aren't a server's. */
const FREQUENT = 'frequent';
const STANDARD = 'standard';

/** Lists frequent emoji, server emoji in sidebar order, then standard groups. Marks track/jump sections; unavailable emoji disable; shift sets keep. */
export function EmojiList(props: { guildId: string; onPick: OnPick }) {
  let body!: HTMLDivElement;
  const [query, setQuery] = createSignal('');
  const [current, setCurrent] = createSignal(FREQUENT);
  onMount(loadUnicodeEmojiData);
  const q = (): string => normalQuery(query());
  const byGuild = createMemo(() => emojisByGuild(q()));
  const servers = (): DirectoryGuild[] => directory().filter((g) => byGuild().has(g.id));
  const groups = createMemo(() => unicodeGroups(q()));
  const frequent = () => (q() ? [] : frequentPicks());

  /** The mark of the last section whose top has reached the list's top. */
  const track = (): void => {
    let mark = '';
    for (const el of body.querySelectorAll<HTMLElement>('[data-bar]')) {
      if (el.offsetTop > body.scrollTop) break;
      mark = el.dataset['bar']!;
    }
    setCurrent(mark || (body.querySelector<HTMLElement>('[data-bar]')?.dataset['bar'] ?? FREQUENT));
  };
  const jump = (mark: string): void => {
    const el = body.querySelector<HTMLElement>(`[data-bar="${mark}"]`);
    if (el) body.scrollTop = el.offsetTop;
    setCurrent(mark);
  };

  const Mark = (p: { mark: string; label: string; icon?: IconName; guild?: DirectoryGuild }) => (
    <button type="button" class={styles.mark} aria-label={p.label} title={p.label} aria-current={current() === p.mark} onClick={() => jump(p.mark)}>
      <Show when={p.guild} fallback={<Icon name={p.icon!} />}>
        {(g) => <GuildIcon id={g().id} name={g().name} icon={g().icon} />}
      </Show>
    </button>
  );

  return (
    <div class={styles.root}>
      <PickerSearch label="Find the perfect reaction" value={query()} onInput={setQuery} />
      <div class={styles.main}>
        <nav class={styles.bar} aria-label="Emoji sections">
          <Show when={frequent().length}>
            <Mark mark={FREQUENT} label="Frequently Used" icon="clock" />
          </Show>
          <For each={servers()}>{(g) => <Mark mark={g.id} label={g.name} guild={g} />}</For>
          <Show when={groups().length}>
            <Mark mark={STANDARD} label="Standard emoji" icon="emoji" />
          </Show>
        </nav>
        <div ref={body} class={`${picker.body} ${styles.list}`} onScroll={track}>
          <Show when={expressionCatalog.error ?? frequentEmoji.error ?? unicodeEmoji.error}>{(err) => <p class="cp-error">Couldn't load emoji: {errorText(err())}</p>}</Show>
          <Show when={frequent().length}>
            <PickerSection title="Frequently Used" bar={FREQUENT}>
              <div class={picker.emojiGrid}>
                <For each={frequent()}>
                  {(f) => ('custom' in f ? <CustomButton emoji={f.custom} usable={usableIn(f.custom, props.guildId)} onPick={props.onPick} /> : <UnicodeButton text={f.unicode} title={f.unicode} onPick={props.onPick} />)}
                </For>
              </div>
            </PickerSection>
          </Show>
          <For each={servers()}>
            {(g) => (
              <PickerSection title={g.name} bar={g.id}>
                <div class={picker.emojiGrid}>
                  <For each={byGuild().get(g.id)}>{(e) => <CustomButton emoji={e} usable={usableIn(e, props.guildId)} onPick={props.onPick} />}</For>
                </div>
              </PickerSection>
            )}
          </For>
          <For each={groups()}>
            {(g, i) => (
              <PickerSection title={g.name} bar={i() === 0 ? STANDARD : undefined}>
                <div class={picker.emojiGrid}>
                  <For each={g.emojis}>{(e) => <UnicodeButton text={e.emoji} title={e.shortcodes[0] ? `:${e.shortcodes[0]}:` : e.label} onPick={props.onPick} />}</For>
                </div>
              </PickerSection>
            )}
          </For>
          <Show when={q() && !servers().length && !groups().length && !expressionCatalog.loading && !unicodeEmoji.loading}>
            <p class="cp-panel-empty">No emoji match “{query()}”.</p>
          </Show>
        </div>
      </div>
    </div>
  );
}
