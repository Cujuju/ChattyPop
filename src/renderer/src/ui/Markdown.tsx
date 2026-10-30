import { For, Match, Switch, createContext, createSignal, useContext, type Accessor, type JSX } from 'solid-js';
import { SEARCH_MATCH_END, SEARCH_MATCH_START } from '@shared/contract';
import { EmojiImage } from '@/ui/AnimatedImage';
import { timeFormat } from '@shared/hourCycle';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN, MS_PER_S } from '@shared/units';
import { channelById } from '@/state/directory';
import { openPerson } from '@/state/person';
import { personName } from '@/state/personNames';
import { AuthorName } from '@/panels/chat/AuthorName';
import { drawnName } from '@/panels/chat/PersonName';
import { clockTime } from './format';
import { SenderSpoiler, SpoilersShown } from './spoilers';
import { MarkdownLink } from './MarkdownLink';
import { MessageEmoji } from '@/panels/chat/MessageEmoji';
import { parseInline, parseMarkdown, type MdBlock, type MdInline } from './mdParse';
import styles from './Markdown.module.css';

const MIN_PER_HOUR = MS_PER_HOUR / MS_PER_MIN;
const MIN_PER_DAY = MS_PER_DAY / MS_PER_MIN;

/** Formats Discord <t:unix:style> timestamps (unix seconds) in the viewer's locale. */
function formatTime(unix: number, style: string): string {
  const d = new Date(unix * MS_PER_S);
  switch (style) {
    case 't':
      return clockTime(d.getTime());
    case 'T':
      return timeFormat({ timeStyle: 'medium' }).format(d);
    case 'd':
      return d.toLocaleDateString();
    case 'D':
      return d.toLocaleDateString([], { dateStyle: 'long' });
    case 'F':
      return timeFormat({ dateStyle: 'full', timeStyle: 'short' }).format(d);
    case 'R': {
      const rtf = new Intl.RelativeTimeFormat([], { numeric: 'auto' });
      const mins = Math.round((d.getTime() - Date.now()) / MS_PER_MIN);
      return Math.abs(mins) < MIN_PER_HOUR
        ? rtf.format(mins, 'minute')
        : Math.abs(mins) < MIN_PER_DAY
          ? rtf.format(Math.round(mins / MIN_PER_HOUR), 'hour')
          : rtf.format(Math.round(mins / MIN_PER_DAY), 'day');
    }
    default:
      return timeFormat({ dateStyle: 'long', timeStyle: 'short' }).format(d);
  }
}

function Spoiler(props: { children: JSX.Element; inert: boolean }) {
  const [revealed, setShown] = createSignal(false);
  const uncovered = useContext(SpoilersShown);
  const shown = (): boolean => uncovered() || revealed();
  // Inert spoilers remain hidden inside clickable rows to avoid activating those rows.
  if (props.inert) return <span class={styles.spoiler} data-shown="false">{props.children}</span>;
  return (
    <span class={styles.spoiler} data-shown={shown()} role="button" tabIndex={0} aria-label={shown() ? undefined : 'Spoiler, press to reveal'} onClick={() => setShown(true)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShown(true)}>
      <SenderSpoiler.Provider value={true}>{props.children}</SenderSpoiler.Provider>
    </span>
  );
}

/** Search snippets: text shows its matches (between SEARCH_MATCH_START and _END) highlighted, the delimiters hidden. */
const MatchMarks = createContext(false);
const MATCH_DELIMITER = new RegExp(`([${SEARCH_MATCH_START}${SEARCH_MATCH_END}])`);

/** Text split at match delimiters; a delimiter a match was cut at (by the snippet's edge or a token) just ends it. */
function matchParts(text: string): { text: string; hit: boolean }[] {
  let hit = false;
  return text.split(MATCH_DELIMITER).flatMap((part) => {
    if (part === SEARCH_MATCH_START || part === SEARCH_MATCH_END) {
      hit = part === SEARCH_MATCH_START;
      return [];
    }
    return part ? [{ text: part, hit }] : [];
  });
}

/** A text leaf: plain, or with its search matches marked inside MatchMarks. */
function Text(props: { text: string }) {
  if (!useContext(MatchMarks)) return <>{props.text}</>;
  return <For each={matchParts(props.text)}>{(p) => (p.hit ? <mark class={styles.match}>{p.text}</mark> : p.text)}</For>;
}

/** Where the text is drawn: `channelId` names user mentions as that server shows them; `profiles` lets a click open their profile there. */
export interface MentionPlace {
  channelId: string | null;
  profiles: boolean;
}
/** Unset (a plugin's view, a bio): user mentions show the names the text carries, unstyled. */
export const MentionPlace = createContext<Accessor<MentionPlace> | null>(null);

/** Discord's text for a mention of someone it can't name. */
const UNKNOWN_MENTION = 'unknown-user';

/** A user mention drawn as their name shows in the place: nickname, role colour, Nitro font; the text's own name until core answers. */
function UserMention(props: { id: string; fallback: string | undefined; place: Accessor<MentionPlace>; inert?: boolean }) {
  const channelId = () => props.place().channelId;
  const drawn = () => {
    const d = drawnName(props.id, channelId(), props.fallback ?? UNKNOWN_MENTION);
    return { ...d, name: `@${d.name}` };
  };
  // The place core read the name for: privacy mode may have withheld the one asked for.
  const open = () => openPerson(props.id, personName(props.id, channelId())?.channelId ?? null);
  return <AuthorName author={drawn()} class={styles.mention} onClick={!props.inert && props.place().profiles ? open : undefined} />;
}

/** `inert`: drawn inside a clickable row, so links are text and spoilers don't open. */
function Inline(props: { nodes: MdInline[]; mentions: Record<string, string>; jumbo: boolean; inert?: boolean }) {
  const channelName = (id: string): string => channelById(id)?.name ?? 'unknown-channel';
  const place = useContext(MentionPlace);
  return (
    <For each={props.nodes}>
      {(n) => (
        <Switch>
          <Match when={n.k === 'text' && n}>{(t) => <Text text={t().text} />}</Match>
          <Match when={n.k === 'strong' && n}>{(x) => <strong><Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></strong>}</Match>
          <Match when={n.k === 'em' && n}>{(x) => <em><Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></em>}</Match>
          <Match when={n.k === 'u' && n}>{(x) => <u><Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></u>}</Match>
          <Match when={n.k === 's' && n}>{(x) => <s><Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></s>}</Match>
          <Match when={n.k === 'spoiler' && n}>
            {(x) => (
              <Spoiler inert={props.inert ?? false}>
                <Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} />
              </Spoiler>
            )}
          </Match>
          <Match when={n.k === 'code' && n}>{(c) => <code class={styles.code}><Text text={c().text} /></code>}</Match>
          <Match when={n.k === 'link' && props.inert && n}>
            {(l) => (
              <span class={styles.link}>
                <Inline nodes={l().children} mentions={props.mentions} jumbo={false} inert />
              </span>
            )}
          </Match>
          <Match when={n.k === 'link' && n}>
            {(l) => (
              <MarkdownLink class={styles.link} href={l().href}>
                <Inline nodes={l().children} mentions={props.mentions} jumbo={false} inert={props.inert} />
              </MarkdownLink>
            )}
          </Match>
          {/* data-text-emoji: text to gestures (ui/touch.ts), so a double tap on it reacts as on the words around it. */}
          <Match when={n.k === 'emoji' && props.inert && n}>
            {(e) => <EmojiImage class={styles.emoji} data-text-emoji data-jumbo={props.jumbo} emoji={e()} alt={`:${e().name}:`} title={`:${e().name}:`} loading="lazy" />}
          </Match>
          <Match when={n.k === 'emoji' && n}>{(e) => <MessageEmoji class={styles.emoji!} emoji={e()} jumbo={props.jumbo} />}</Match>
          <Match when={n.k === 'mention' && n.kind === 'user' && place && n}>
            {(m) => <UserMention id={m().id} fallback={props.mentions[m().id]} place={place!} inert={props.inert} />}
          </Match>
          <Match when={n.k === 'mention' && n}>
            {(m) => (
              <span class={styles.mention}>
                {m().kind === 'user' ? `@${props.mentions[m().id] ?? UNKNOWN_MENTION}` : m().kind === 'channel' ? `#${channelName(m().id)}` : m().kind === 'role' ? '@role' : `@${m().id}`}
              </span>
            )}
          </Match>
          <Match when={n.k === 'time' && n}>
            {(t) => (
              <time class={styles.timestamp} dateTime={new Date(t().unix * MS_PER_S).toISOString()}>
                {formatTime(t().unix, t().style)}
              </time>
            )}
          </Match>
        </Switch>
      )}
    </For>
  );
}

function Blocks(props: { blocks: MdBlock[]; mentions: Record<string, string>; jumbo: boolean; inert?: boolean }) {
  return (
    <For each={props.blocks}>
      {(b) => (
        <Switch>
          <Match when={b.k === 'p' && b}>{(p) => <span class={styles.p}><Inline nodes={p().children} mentions={props.mentions} jumbo={props.jumbo} inert={props.inert} /></span>}</Match>
          <Match when={b.k === 'h' && b}>{(h) => <span class={styles.h} data-level={h().level}><Inline nodes={h().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></span>}</Match>
          <Match when={b.k === 'subtext' && b}>{(x) => <span class={styles.subtext}><Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></span>}</Match>
          <Match when={b.k === 'li' && b}>{(x) => <span class={styles.li}><Inline nodes={x().children} mentions={props.mentions} jumbo={false} inert={props.inert} /></span>}</Match>
          <Match when={b.k === 'quote' && b}>{(q) => <span class={styles.quote}><Blocks blocks={q().blocks} mentions={props.mentions} jumbo={false} inert={props.inert} /></span>}</Match>
          <Match when={b.k === 'codeblock' && b}>{(c) => <code class={styles.codeblock} data-lang={c().lang || undefined}><Text text={c().text} /></code>}</Match>
        </Switch>
      )}
    </For>
  );
}

/**
 * Discord-flavoured markdown as elements (never HTML strings). `jumbo` enlarges emoji in an emoji-only message.
 * Rendered with spans so it can sit inside a <p>. `inert` for text inside a clickable row; `marks` for a search snippet.
 */
export function Markdown(props: { text: string; mentions?: Record<string, string>; jumbo?: boolean; inert?: boolean; marks?: boolean }) {
  const blocks = () => parseMarkdown(props.text);
  return (
    <MatchMarks.Provider value={props.marks ?? false}>
      <Blocks blocks={blocks()} mentions={props.mentions ?? {}} jumbo={props.jumbo ?? false} inert={props.inert} />
    </MatchMarks.Provider>
  );
}

/**
 * Inline-only markdown on one line (reply previews, alert and run snippets): no blocks, no line breaks. `inert` for text
 * inside a clickable row.
 */
export function InlineMarkdown(props: { text: string; mentions?: Record<string, string>; inert?: boolean }) {
  return <Inline nodes={parseInline(props.text.replace(/\s*\n\s*/g, ' '))} mentions={props.mentions ?? {}} jumbo={false} inert={props.inert} />;
}
