// Archive message rows, content, labels and attachment rendering.
import { coverageText } from '@/plugins/presentation';
import { For, Show, children, createSignal, type JSX } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { avatarUrl, decorationUrl } from '@shared/media';
import type { ArchiveDensity } from '@/state/archive';
import { messageLink, openMessageMenu } from '@/state/messageActions';
import { mentionsMe } from '@/state/ownMessages';
import { openPerson } from '@/state/person';
import { postingUnlocked } from '@/state/posting';
import { pluginPresents } from '@/state/plugins';
import { canReply, startReply } from '@/state/reply';
import { contextMenu, inCompanion } from '@/state/ui';
import { SolidIcon } from '@/ui/solidIcons';
import styles from './MessageRow.module.css';
import { today } from '@/state/clock';
import { clockTime as time, messageTime } from '@/ui/format';
import { Markdown } from '@/ui/Markdown';
import { isEmojiOnly } from '@/ui/mdParse';
import { swipeLeftToAct } from '@/ui/touch';
import { rowMenuTarget } from '@/ui/VirtualRows';
import { Note } from './Attachment';
import { Attachments } from './Attachments';
import { AuthorName } from './AuthorName';
import { MessageActionBar } from './MessageActionBar';
import { presentedParts } from './ownedParts';
import { MessageEditor } from './MessageEditor';
import { InteractionLine, MessageComponents } from './MessageComponents';
import { Embeds, Reactions, ReplyLine, Stickers, textIsEmbedLink } from './MessageExtras';
import cozy from './Cozy.module.css';
import { look } from '@/theme/look';

/** Discord shows up to this many emoji large when a message has nothing else. */
const MAX_JUMBO_EMOJI = 27;

export interface MessageRowProps {
  message: ArchiveMessage;
  focused: boolean;
  /** The owner is editing it here (the Archive's editor, state/edit.ts): the editor replaces its text. */
  editing?: boolean;
  density: ArchiveDensity;
  /** Cozy only: continues the previous message's author group (no avatar or name). */
  grouped: boolean;
  /** Cozy only: under the avatar (a shared link's platform badge). */
  gutter?: JSX.Element;
  /** Cozy only: after the time on the name line (where a shared link was posted). */
  headExtra?: JSX.Element;
  /** After the message body (a shared link's extra card and Jev's reading of it). */
  children?: JSX.Element;
}

/** One archived message, in the cozy (avatar, grouped) or compact (F2 time | author | body log) layout. */
export function MessageRow(props: MessageRowProps) {
  return (
    <Show when={props.density === 'cozy'} fallback={<CompactRow {...props} />}>
      <CozyRow {...props} />
    </Show>
  );
}

function CompactRow(props: MessageRowProps) {
  const m = () => props.message;
  const swipe = swipeToReply(m);
  const bar = createActionBar(props);
  return (
    <article
      class={styles.row}
      data-deleted={m().deletedAt !== null}
      data-edited={m().revisions.length > 0}
      data-focused={props.focused}
      data-mention={mentionsMe(m())}
      data-menu={contextMenu()?.messageId === m().id}
      aria-label={`${m().author.name}, ${messageTime(m().ts, today())}`}
      {...rowMenuTarget}
      onContextMenu={(e) => openMessageMenu(e, m())}
      onTouchStart={swipe.onTouchStart}
      onTouchMove={swipe.onTouchMove}
      onTouchEnd={swipe.onTouchEnd}
      onTouchCancel={swipe.onTouchCancel}
      onPointerEnter={bar.enter}
      onPointerLeave={bar.leave}
    >
      <SwipeReplyMark />
      <Show when={bar.shown()}>
        <MessageActionBar message={m()} onFocusWithin={bar.focusWithin} />
      </Show>
      <time class={styles.time} dateTime={new Date(m().ts).toISOString()}>
        {time(m().ts)}
      </time>
      <AuthorName author={m().author} class={styles.author} title={accountName(m()) ?? undefined} onClick={() => openPerson(m().author.id)} />
      <div class={styles.compactMain}>
        <Show when={m().reply}>{(r) => <ReplyLine reply={r()} channelId={m().channelId} pinged={m().mentionIds.includes(r().authorId)} />}</Show>
        <Show when={m().interaction}>{(i) => <InteractionLine interaction={i()} />}</Show>
        <MessageBody message={m()} editing={props.editing === true} />
        {props.children}
      </div>
    </article>
  );
}

function CozyRow(props: MessageRowProps) {
  const m = () => props.message;
  const swipe = swipeToReply(m);
  const bar = createActionBar(props);
  // Resolve JSX props once to avoid rebuilding content.
  const gutter = children(() => props.gutter);
  return (
    <article
      class={`${styles.row} ${cozy.row}`}
      data-density="cozy"
      data-deleted={m().deletedAt !== null}
      data-edited={m().revisions.length > 0}
      data-focused={props.focused}
      data-mention={mentionsMe(m())}
      data-menu={contextMenu()?.messageId === m().id}
      data-grouped={props.grouped}
      aria-label={`${m().author.name}, ${messageTime(m().ts, today())}`}
      {...rowMenuTarget}
      onContextMenu={(e) => openMessageMenu(e, m())}
      onTouchStart={swipe.onTouchStart}
      onTouchMove={swipe.onTouchMove}
      onTouchEnd={swipe.onTouchEnd}
      onTouchCancel={swipe.onTouchCancel}
      onPointerEnter={bar.enter}
      onPointerLeave={bar.leave}
    >
      <SwipeReplyMark />
      <Show when={bar.shown()}>
        <MessageActionBar message={m()} onFocusWithin={bar.focusWithin} />
      </Show>
      <Show
        when={!props.grouped}
        fallback={
          <time class={cozy.gutterTime} dateTime={new Date(m().ts).toISOString()}>
            {time(m().ts)}
          </time>
        }
      >
        <Show when={gutter()} fallback={<Avatar message={m()} />}>
          <div class={cozy.gutter}>
            <Avatar message={m()} />
            {gutter()}
          </div>
        </Show>
      </Show>
      <div class={cozy.main}>
        <Show when={m().reply}>{(r) => <ReplyLine reply={r()} channelId={m().channelId} pinged={m().mentionIds.includes(r().authorId)} />}</Show>
        <Show when={m().interaction}>{(i) => <InteractionLine interaction={i()} />}</Show>
        <Show when={!props.grouped}>
          <div class={cozy.head}>
            <AuthorName author={m().author} class={cozy.name} onClick={() => openPerson(m().author.id)} />
            <time class={cozy.time} dateTime={new Date(m().ts).toISOString()}>
              {messageTime(m().ts, today())}
            </time>
            {props.headExtra}
          </div>
        </Show>
        <MessageBody message={m()} editing={props.editing === true} />
        {props.children}
      </div>
    </article>
  );
}

/** Shows action bars for hover, bar focus or open menus. Excludes phone and active editors. */
function createActionBar(props: MessageRowProps) {
  const [hovered, setHovered] = createSignal(false);
  const [focused, setFocused] = createSignal(false);
  return {
    enter: (e: PointerEvent) => void (e.pointerType === 'mouse' && setHovered(true)),
    leave: () => void setHovered(false),
    /** Retain focused bars to preserve button focus. */
    focusWithin: (inside: boolean) => void setFocused(inside),
    shown: () => !inCompanion && props.editing !== true && (hovered() || focused() || contextMenu()?.messageId === props.message.id),
  };
}

/** A swipe to the left on the row replies to its message, as in Discord's app; not while posting is locked. */
const swipeToReply = (m: () => ArchiveMessage) =>
  swipeLeftToAct(
    () => startReply(m()),
    () => postingUnlocked() && canReply(m()),
  );

/** The reply arrow a swipe reveals at the row's trailing edge; the stylesheet grows it with the swipe. */
function SwipeReplyMark() {
  return (
    <span class={styles.swipeMark} aria-hidden="true">
      <SolidIcon name="reply" />
    </span>
  );
}

/** The account name, the compact name's tooltip when it differs from the display name; the profile shows it too. */
function accountName(m: ArchiveMessage): string | null {
  const u = m.author.username;
  return u && u.toLowerCase() !== m.author.name.toLowerCase() ? u : null;
}

function Avatar(props: { message: ArchiveMessage }) {
  const a = () => props.message.author;
  const img = () => <img data-avatar class={`${cozy.avatar} ${look.avatar}`} src={avatarUrl(a().id, a().avatar)} alt="" loading="lazy" onClick={() => openPerson(a().id)} />;
  // The decoration frames the avatar, as in Discord: still, animated while the message is hovered.
  return (
    <Show when={a().decoration} fallback={img()}>
      {(asset) => (
        <span class={cozy.decorated}>
          {img()}
          <img class={cozy.decoration} src={decorationUrl(asset(), false)} alt="" loading="lazy" />
          <img class={cozy.decoration} data-animated src={decorationUrl(asset(), true)} alt="" loading="lazy" />
        </span>
      )}
    </Show>
  );
}

/** Deletion note, text with edit mark (or the owner's editor), earlier revisions and attachments: shared by both layouts. */
function MessageBody(props: { message: ArchiveMessage; editing: boolean }) {
  const m = () => props.message;
  // A loaded message may outlive its parts' owners: their chips and notes leave with them.
  const labels = () => presentedParts(m().labels, pluginPresents);
  return (
    <div class={styles.body}>
      <Show when={m().deletedAt}>{(at) => <p class={styles.deletedNote}>Deleted by author {time(at())} · original kept in archive</p>}</Show>
      <Show when={labels().length}>
        <span class={styles.labels}>
          <For each={labels()}>
            {(l) => (
              <span
                class={`${styles.tag} ${look.tag}`}
                data-tag={l.pluginId ? undefined : l.text.toLowerCase()}
                data-own={l.variant}
                title={l.title}
              >
                {l.text}
              </span>
            )}
          </For>
        </span>
      </Show>
      <Show when={m().prunedAt}>{(at) => <p class={styles.deletedNote}>Text removed {time(at())} by text retention · {coverageText().covered}</p>}</Show>
      <Show when={!props.editing} fallback={<MessageEditor />}>
        <Show when={m().content && !textIsEmbedLink(m().content, m().embeds)}>
          <p class={styles.content}>
            <Markdown text={m().content} mentions={m().mentions} jumbo={isEmojiOnly(m().content, MAX_JUMBO_EMOJI)} />
            <Show when={m().editedTs}>{(at) => <span class={styles.editedMark}> (edited {time(at())})</span>}</Show>
          </p>
        </Show>
      </Show>
      <For each={m().revisions}>
        {(r) => (
          <div class={styles.revision}>
            <span class={styles.revisionLabel}>was</span>
            <p class={styles.revisionText}>{r.content}</p>
          </div>
        )}
      </For>
      <For each={presentedParts(m().annotations, pluginPresents)}>
        {(a) => (
          <div class={styles.revision} data-kind="annotation" title={`From plugin ${a.pluginId}`}>
            <span class={styles.revisionLabel}>{a.label}</span>
            <p class={styles.revisionText}>{a.text}</p>
          </div>
        )}
      </For>
      {/* Notes on links no card shows (a linked post's translation). */}
      <For each={presentedParts(m().notes ?? [], pluginPresents)}>{(n) => <Note note={n} />}</For>
      <Attachments message={m()} messageLink={messageLink(m())} />
      <Stickers stickers={m().stickers} />
      <Embeds embeds={m().embeds} mentions={m().mentions} />
      <MessageComponents message={m()} />
      <Reactions message={m()} />
    </div>
  );
}
