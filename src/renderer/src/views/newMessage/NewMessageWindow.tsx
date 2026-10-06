import { For, Show, createEffect, createMemo, createSignal, on } from 'solid-js';
import { DM_UNCERTAIN_TEXT, GROUP_DM_MAX_MEMBERS } from '@shared/dms';
import { avatarUrl } from '@shared/media';
import {
  addTarget,
  addingFriends,
  candidates,
  closeNewMessage,
  enterSends,
  makesGroup,
  memberIds,
  newMessageOpen,
  newMessageSession,
  pickKey,
  pickSending,
  pickUnconfirmed,
  retargetAddFriends,
  sendPicks,
  archiveNewConversations as archive,
  setArchiveNewConversations as setArchive,
  type Candidate,
} from '@/state/newMessage';
import { createAction } from '@/ui/action';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { Icon } from '@/ui/icons';
import { createListNav } from '@/ui/listNav';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './NewMessage.module.css';

/** Ids tying the To field to its list for assistive tech; one New message window per document. */
const LIST_ID = 'new-message-people';
const optionId = (p: Candidate): string => `new-message-person-${p.id}`;
/** The owner counts toward a group's cap. */
const OWNER = 1;
const SECTION_LABELS: Record<Candidate['section'], string> = { dms: 'Your DMs', friends: 'Friends' };

/** A person's face, else their initial. */
function Face(props: { person: Candidate; class: string | undefined }) {
  return (
    <Show when={props.person.avatar !== null} fallback={<span class={`${props.class} ${styles.initial}`}>{[...props.person.name][0] ?? ''}</span>}>
      <img class={props.class} src={avatarUrl(props.person.id, props.person.avatar)} alt="" loading="lazy" />
    </Show>
  );
}

/** Selects DM/friend recipients or additional friends; multiple recipients create groups. Existing open DMs need no request. Pending/uncertain picks remain deduplicated across reopening. */
export function NewMessageWindow() {
  const [query, setQuery] = createSignal('');
  const [picked, setPicked] = createSignal<Candidate[]>([]);
  const action = createAction();
  const { busy, error } = action;
  /** Those in the conversation being added to, besides the owner; none for a new one. */
  const members = createMemo(() => {
    const t = addTarget();
    return t ? memberIds(t) : [];
  });
  const people = createMemo(() => (addingFriends() ? candidates(query(), new Set(members())).filter((p) => p.friend) : candidates(query())));
  const pickedIds = createMemo(() => new Set(picked().map((p) => p.id)));
  const key = (): string => pickKey(addTarget()?.id ?? null, [...pickedIds()]);
  const group = (): boolean => addingFriends() || picked().length > 1;
  /** The group's size as picked: the owner, those already in it, and the picks. */
  const size = (): number => OWNER + members().length + picked().length;
  const full = (): boolean => size() >= GROUP_DM_MAX_MEMBERS;
  const existing = (): string | null => (!addingFriends() && picked().length === 1 ? picked()[0]!.dmId : null);
  /** Adding to a one-to-one DM makes a new group, which the archive choice applies to. */
  const newGroupFromDm = (): boolean => {
    const t = addTarget();
    return t !== undefined && makesGroup(t);
  };
  /** Opening an open DM sends nothing, so only a request is held back. */
  const sending = (): boolean => busy() || (!existing() && pickSending(key()));
  const unconfirmed = (): boolean => !existing() && pickUnconfirmed(key());
  const problem = (): string | null =>
    addingFriends() && !addTarget()
      ? 'This conversation is no longer listed.'
      : group() && picked().some((p) => !p.friend)
        ? 'Only friends can be in a group.'
        : unconfirmed() && !busy()
          ? DM_UNCERTAIN_TEXT
          : null;
  const title = (): string => {
    const t = addTarget();
    return t ? `Add friends to ${t.name}` : group() ? 'New group' : 'New message';
  };
  const submitLabel = (): string =>
    sending() ? 'Sending…' : addingFriends() ? (newGroupFromDm() ? 'Start group' : 'Add to group') : existing() ? 'Open conversation' : group() ? 'Start group' : 'Start conversation';
  const ready = (): boolean => picked().length > 0 && !sending() && !unconfirmed() && !problem();
  const emptyText = (): string => {
    const q = query().trim();
    if (addingFriends()) return q ? `No friend matches “${q}”.` : 'No friends to add.';
    return q ? `No friend or conversation matches “${q}”.` : 'No friends or conversations yet.';
  };
  let list: HTMLUListElement | undefined;
  let field: HTMLInputElement | undefined;

  const toggle = (p: Candidate | undefined): void => {
    if (!p || busy()) return;
    if (pickedIds().has(p.id)) setPicked(picked().filter((x) => x.id !== p.id));
    else if (!full()) setPicked([...picked(), p]);
    setQuery('');
    field?.focus();
  };
  const submit = async (): Promise<void> => {
    if (!ready()) return;
    const ids = [...pickedIds()];
    const outcome = await action.run(() => sendPicks(addTarget(), ids, archive()));
    // An uncertain outcome holds its picks (pickUnconfirmed), which shows why.
    if (!outcome || outcome.kind === 'uncertain') return;
    if (!outcome.failed) return closeNewMessage();
    // The others are in (a group the first add made): a retry adds only those left, there.
    const left = new Set(outcome.failed.userIds);
    retargetAddFriends(outcome.channelId);
    setPicked(picked().filter((p) => left.has(p.id)));
    action.setError(`Added ${ids.length - left.size} of ${ids.length}. ${outcome.failed.reason}`);
  };
  const nav = createListNav(() => people().length, {
    // Reached only when Enter picks (onKey sends first when enterSends says so).
    onEnter: (i) => toggle(people()[i]),
    onEscape: () => closeNewMessage(),
    activeEl: () => list?.querySelector('[data-active="true"]'),
    stopPropagation: true,
  });
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Enter' && enterSends(e, people()[nav.active()] !== undefined)) {
      e.preventDefault();
      e.stopPropagation();
      void submit();
    } else if (e.key === 'Backspace' && !query() && picked().length && !busy()) setPicked(picked().slice(0, -1));
    else nav.onKey(e);
  };

  createEffect(
    // Each opening starts afresh, as does opening it for another conversation while open.
    on(newMessageSession, () => {
      if (!newMessageOpen()) return;
      action.cancel();
      setQuery('');
      setPicked([]);
    }),
  );
  createEffect(on(query, () => nav.setActive(0), { defer: true }));

  return (
    <FloatingWindow id="new-message" open={newMessageOpen()} class={`${chrome.dialog} ${styles.window}`} aria-label={title()} onClose={closeNewMessage}>
      <WindowHeader
        title={
          <>
            {title()}
            <Show when={group()}>
              <span class={styles.count}>
                {size()} of {GROUP_DM_MAX_MEMBERS}
              </span>
            </Show>
          </>
        }
        classes={chrome}
        closeLabel="Close"
        onClose={closeNewMessage}
      />
      <form
        class={styles.form}
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <div class={styles.pick}>
          {/* The To field: picked people as chips, then the search; a click anywhere in it types there. */}
          <div class={styles.to} onClick={() => field?.focus()}>
            <span class={styles.toLabel}>To:</span>
            <For each={picked()}>
              {(p) => (
                <span class={styles.chip}>
                  <Face person={p} class={styles.chipFace} />
                  <span class={styles.chipName}>{p.name}</span>
                  <button type="button" class={styles.chipRemove} aria-label={`Remove ${p.name}`} disabled={busy()} onClick={() => toggle(p)}>
                    <Icon name="close" />
                  </button>
                </span>
              )}
            </For>
            <input
              ref={field}
              class={styles.toField}
              type="text"
              placeholder={picked().length ? '' : 'Type a friend’s name'}
              aria-label="Who to message"
              aria-controls={LIST_ID}
              aria-activedescendant={people()[nav.active()] ? optionId(people()[nav.active()]!) : undefined}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={onKey}
              disabled={busy()}
              autofocus
            />
          </div>
          <ul id={LIST_ID} class={styles.people} role="listbox" aria-multiselectable="true" aria-label="People" ref={list}>
            <For
              each={people()}
              fallback={<li class={styles.empty}>{emptyText()}</li>}
            >
              {(p, i) => (
                <>
                  <Show when={i() === 0 || people()[i() - 1]?.section !== p.section}>
                    <li class={styles.heading} role="presentation">
                      {SECTION_LABELS[p.section]}
                    </li>
                  </Show>
                  <li
                    id={optionId(p)}
                    class={styles.person}
                    role="option"
                    aria-selected={pickedIds().has(p.id)}
                    aria-disabled={busy() || (full() && !pickedIds().has(p.id))}
                    data-active={nav.active() === i()}
                    onClick={() => toggle(p)}
                  >
                    <Face person={p} class={styles.face} />
                    <span class={styles.names}>
                      <span class={styles.name}>{p.name}</span>
                      <span class={styles.detail}>{p.detail}</span>
                    </span>
                    <span class={styles.mark} aria-hidden="true" />
                  </li>
                </>
              )}
            </For>
          </ul>
        </div>
        <div class={styles.foot}>
          <Show when={problem() ?? error()}>
            {(text) => (
              <p class={`cp-error ${styles.error}`} role="alert">
                {text()}
              </p>
            )}
          </Show>
          <div class={styles.actions}>
            <Show when={!existing() && (!addingFriends() || newGroupFromDm())}>
              <label class={`cp-check ${styles.archive}`}>
                <input type="checkbox" checked={archive()} disabled={busy()} onChange={(e) => void setArchive(e.currentTarget.checked)} />
                Archive this conversation
              </label>
            </Show>
            <button type="button" class={`cp-button ${styles.button}`} onClick={closeNewMessage}>
              Cancel
            </button>
            <button type="submit" class={`cp-primary ${styles.button}`} disabled={!ready()}>
              {submitLabel()}
            </button>
          </div>
        </div>
      </form>
    </FloatingWindow>
  );
}
