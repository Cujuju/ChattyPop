// Archive message rows, content, labels and attachment rendering.
import { Show, children, createSignal, type JSX } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { avatarUrl, decorationUrl } from '@shared/media';
import type { ArchiveDensity } from '@/state/archive';
import { openConversation } from '@/state/conversation';
import { openMessageMenu } from '@/state/messageActions';
import { mentionsMe } from '@/state/ownMessages';
import { openPerson, openPersonFromPlugin } from '@/state/person';
import { contextMenu, inCompanion } from '@/state/ui';
import { SolidIcon } from '@/ui/solidIcons';
import styles from './MessageRow.module.css';
import { today } from '@/state/clock';
import { clockTime as time, messageTime } from '@/ui/format';
import { rowMenuTarget } from '@/ui/VirtualRows';
import { AuthorName } from './AuthorName';
import { MessageActionBar } from './MessageActionBar';
import { rowGestures } from './rowGestures';
import { MessageBody } from './MessageBody';
import { InteractionLine } from './MessageComponents';
import { ReplyLine } from './MessageExtras';
import cozy from './Cozy.module.css';
import { look } from '@/theme/look';

export interface MessageRowProps {
  message: ArchiveMessage;
  focused: boolean;
  /** Ticked in the Archive's selection (state/messageSelection.ts). Given only by the Archive view: its rows alone can be selected. */
  selected?: boolean;
  /** The owner is editing it here (the Archive's editor, state/edit.ts): the editor replaces its text. */
  editing?: boolean;
  density: ArchiveDensity;
  /** Cozy only: continues the previous message's author group (no avatar or name). */
  grouped: boolean;
  /** Cozy only: under the avatar (a shared link's platform badge). */
  gutter?: JSX.Element;
  /** Cozy only: after the time on the name line (where a shared link was posted). */
  headExtra?: JSX.Element;
  /** Show the conversation shortcut after the time; defaults to shown. */
  conversationButton?: boolean;
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
  const gestures = rowGestures(m);
  const bar = createActionBar(props);
  return (
    <article
      class={styles.row}
      data-deleted={m().deletedAt !== null}
      data-edited={m().revisions.length > 0}
      data-focused={props.focused}
      data-selected={props.selected === true}
      data-mention={mentionsMe(m())}
      data-menu={contextMenu()?.messageId === m().id}
      aria-label={`${m().author.name}, ${messageTime(m().ts, today())}`}
      {...rowMenuTarget}
      onContextMenu={(e) => openMessageMenu(e, m())}
      onTouchStart={gestures.onTouchStart}
      onTouchMove={gestures.onTouchMove}
      onTouchEnd={gestures.onTouchEnd}
      onTouchCancel={gestures.onTouchCancel}
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
      <Show when={props.conversationButton !== false}>
        <button type="button" class={styles.conversation} aria-label="View conversation" title="View conversation" onClick={() => openConversation(m().id)}>
          <SolidIcon name="conversation" />
        </button>
      </Show>
      <AuthorName author={m().author} class={styles.author} title={accountName(m()) ?? undefined} onClick={() => openPerson(m().author.id, m().channelId)} />
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
  const gestures = rowGestures(m);
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
      data-selected={props.selected === true}
      data-mention={mentionsMe(m())}
      data-menu={contextMenu()?.messageId === m().id}
      data-grouped={props.grouped}
      aria-label={`${m().author.name}, ${messageTime(m().ts, today())}`}
      {...rowMenuTarget}
      onContextMenu={(e) => openMessageMenu(e, m())}
      onTouchStart={gestures.onTouchStart}
      onTouchMove={gestures.onTouchMove}
      onTouchEnd={gestures.onTouchEnd}
      onTouchCancel={gestures.onTouchCancel}
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
        <Show when={gutter()} fallback={<Avatar author={m().author} channelId={m().channelId} />}>
          <div class={cozy.gutter}>
            <Avatar author={m().author} channelId={m().channelId} />
            {gutter()}
          </div>
        </Show>
      </Show>
      <div class={cozy.main}>
        <Show when={m().reply}>{(r) => <ReplyLine reply={r()} channelId={m().channelId} pinged={m().mentionIds.includes(r().authorId)} />}</Show>
        <Show when={m().interaction}>{(i) => <InteractionLine interaction={i()} />}</Show>
        <Show when={!props.grouped}>
          <div class={cozy.head}>
            <AuthorName author={m().author} class={cozy.name} onClick={() => openPerson(m().author.id, m().channelId)} />
            <time class={cozy.time} dateTime={new Date(m().ts).toISOString()}>
              {messageTime(m().ts, today())}
            </time>
            <Show when={props.conversationButton !== false}>
              <button type="button" class={cozy.conversation} aria-label="View conversation" title="View conversation" onClick={() => openConversation(m().id)}>
                <SolidIcon name="conversation" />
              </button>
            </Show>
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

/** `channelId`: the message's, whose server the profile opens in; plugins built before it omit it (openPersonFromPlugin). */
export function Avatar(props: { author: ArchiveMessage['author']; channelId?: string | null }) {
  const a = () => props.author;
  const img = () => <img data-avatar class={`${cozy.avatar} ${look.avatar}`} src={avatarUrl(a().id, a().avatar)} alt="" loading="lazy" onClick={() => openPersonFromPlugin(a().id, props.channelId)} />;
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
