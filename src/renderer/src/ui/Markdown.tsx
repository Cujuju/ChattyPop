import { For, Match, Switch, createSignal, type JSX } from 'solid-js';
import { emojiUrl } from '@shared/emoji';
import { MS_PER_DAY, MS_PER_HOUR, MS_PER_MIN, MS_PER_S } from '@shared/units';
import { channelById } from '@/state/directory';
import { clockTime } from './format';
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
      return d.toLocaleTimeString();
    case 'd':
      return d.toLocaleDateString();
    case 'D':
      return d.toLocaleDateString([], { dateStyle: 'long' });
    case 'F':
      return d.toLocaleString([], { dateStyle: 'full', timeStyle: 'short' });
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
      return d.toLocaleString([], { dateStyle: 'long', timeStyle: 'short' });
  }
}

function Spoiler(props: { children: JSX.Element; inert: boolean }) {
  const [shown, setShown] = createSignal(false);
  // Inert spoilers remain hidden inside clickable rows to avoid activating those rows.
  if (props.inert) return <span class={styles.spoiler} data-shown="false">{props.children}</span>;
  return (
    <span class={styles.spoiler} data-shown={shown()} role="button" tabIndex={0} aria-label={shown() ? undefined : 'Spoiler, press to reveal'} onClick={() => setShown(true)} onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && setShown(true)}>
      {props.children}
    </span>
  );
}

/** `inert`: drawn inside a clickable row, so links are text and spoilers don't open. */
function Inline(props: { nodes: MdInline[]; mentions: Record<string, string>; jumbo: boolean; inert?: boolean }) {
  const channelName = (id: string): string => channelById(id)?.name ?? 'unknown-channel';
  return (
    <For each={props.nodes}>
      {(n) => (
        <Switch>
          <Match when={n.k === 'text' && n}>{(t) => t().text}</Match>
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
          <Match when={n.k === 'code' && n}>{(c) => <code class={styles.code}>{c().text}</code>}</Match>
          <Match when={n.k === 'link' && props.inert && n}>
            {(l) => (
              <span class={styles.link}>
                <Inline nodes={l().children} mentions={props.mentions} jumbo={false} inert />
              </span>
            )}
          </Match>
          <Match when={n.k === 'link' && n}>
            {(l) => (
              <a class={styles.link} href={l().href} target="_blank" rel="noreferrer" title={l().href}>
                <Inline nodes={l().children} mentions={props.mentions} jumbo={false} inert={props.inert} />
              </a>
            )}
          </Match>
          {/* data-text-emoji: text to gestures (ui/touch.ts), so a double tap on it reacts as on the words around it. */}
          <Match when={n.k === 'emoji' && n}>
            {(e) => <img class={styles.emoji} data-text-emoji data-jumbo={props.jumbo} src={emojiUrl(e())} alt={`:${e().name}:`} title={`:${e().name}:`} loading="lazy" />}
          </Match>
          <Match when={n.k === 'mention' && n}>
            {(m) => (
              <span class={styles.mention}>
                {m().kind === 'user' ? `@${props.mentions[m().id] ?? 'unknown-user'}` : m().kind === 'channel' ? `#${channelName(m().id)}` : m().kind === 'role' ? '@role' : `@${m().id}`}
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

function Blocks(props: { blocks: MdBlock[]; mentions: Record<string, string>; jumbo: boolean }) {
  return (
    <For each={props.blocks}>
      {(b) => (
        <Switch>
          <Match when={b.k === 'p' && b}>{(p) => <span class={styles.p}><Inline nodes={p().children} mentions={props.mentions} jumbo={props.jumbo} /></span>}</Match>
          <Match when={b.k === 'h' && b}>{(h) => <span class={styles.h} data-level={h().level}><Inline nodes={h().children} mentions={props.mentions} jumbo={false} /></span>}</Match>
          <Match when={b.k === 'subtext' && b}>{(x) => <span class={styles.subtext}><Inline nodes={x().children} mentions={props.mentions} jumbo={false} /></span>}</Match>
          <Match when={b.k === 'li' && b}>{(x) => <span class={styles.li}><Inline nodes={x().children} mentions={props.mentions} jumbo={false} /></span>}</Match>
          <Match when={b.k === 'quote' && b}>{(q) => <span class={styles.quote}><Blocks blocks={q().blocks} mentions={props.mentions} jumbo={false} /></span>}</Match>
          <Match when={b.k === 'codeblock' && b}>{(c) => <code class={styles.codeblock} data-lang={c().lang || undefined}>{c().text}</code>}</Match>
        </Switch>
      )}
    </For>
  );
}

/**
 * Discord-flavoured markdown as elements (never HTML strings). `jumbo` enlarges emoji in an emoji-only message.
 * Rendered with spans so it can sit inside a <p>.
 */
export function Markdown(props: { text: string; mentions?: Record<string, string>; jumbo?: boolean }) {
  const blocks = () => parseMarkdown(props.text);
  return <Blocks blocks={blocks()} mentions={props.mentions ?? {}} jumbo={props.jumbo ?? false} />;
}

/**
 * Inline-only markdown on one line (reply previews, alert and run snippets): no blocks, no line breaks. `inert` for text
 * inside a clickable row.
 */
export function InlineMarkdown(props: { text: string; mentions?: Record<string, string>; inert?: boolean }) {
  return <Inline nodes={parseInline(props.text.replace(/\s*\n\s*/g, ' '))} mentions={props.mentions ?? {}} jumbo={false} inert={props.inert} />;
}
