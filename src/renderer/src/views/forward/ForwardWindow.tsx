import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { DISCORD_TEXT_MAX, DM_CHANNEL_TYPES, GROUP_DM_CHANNEL_TYPE } from '@shared/discord';
import { avatarUrl, groupIconUrl } from '@shared/media';
import { today } from '@/state/clock';
import { directory } from '@/state/directory';
import { closeForward, forwardMessage, forwardSource, forwardTargets, forwarding, type ForwardTarget } from '@/state/forward';
import { createAction } from '@/ui/action';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { messageTime } from '@/ui/format';
import { GuildIcon } from '@/ui/GuildIcon';
import { Icon } from '@/ui/icons';
import { createListNav } from '@/ui/listNav';
import chrome from '@/ui/WindowChrome.module.css';
import styles from './Forward.module.css';

/** Destinations listed at once; typing narrows the rest. */
const TARGETS_SHOWN = 50;
/** Ids tying the search field to its list for assistive tech; one Forward window per document. */
const LIST_ID = 'forward-targets';
const optionId = (t: ForwardTarget): string => `forward-target-${t.channel.id}`;

/**
 * Discord's Forward: search for where the message goes, pick it, add an optional note, Forward. The draft is locked while
 * it sends. Hidden, not closed, while privacy mode hides the message's channel.
 */
export function ForwardWindow() {
  const [query, setQuery] = createSignal('');
  const [chosen, setChosen] = createSignal<string | null>(null);
  const [note, setNote] = createSignal('');
  const action = createAction();
  const { busy, error } = action;
  const targets = createMemo(() => forwardTargets(query()).slice(0, TARGETS_SHOWN));
  const chosenTarget = (): ForwardTarget | undefined => targets().find((t) => t.channel.id === chosen());
  let list: HTMLUListElement | undefined;
  const pick = (t: ForwardTarget | undefined): void => {
    if (t && !busy()) setChosen(t.channel.id);
  };
  const nav = createListNav(() => targets().length, {
    onEnter: (i) => pick(targets()[i]),
    onEscape: () => closeForward(),
    activeEl: () => list?.querySelector('[data-active="true"]'),
    stopPropagation: true,
  });

  // A new message starts clean; a send for the previous one must not report here.
  createEffect(
    on(forwarding, () => {
      action.cancel();
      setQuery('');
      setChosen(null);
      setNote('');
    }),
  );
  createEffect(on(query, () => nav.setActive(0), { defer: true }));
  // Only a listed channel stays chosen: one filtered out (or hidden by privacy mode) would be sent to unseen.
  createEffect(() => {
    if (chosen() !== null && !chosenTarget()) setChosen(null);
  });

  const send = async (e: SubmitEvent): Promise<void> => {
    e.preventDefault();
    const m = forwardSource();
    const to = chosen();
    if (!m || !to) return;
    const sent = await action.run(() => forwardMessage(m, to, note()).then(() => true));
    if (sent) closeForward();
  };

  return (
    // Its own geometry id: sized by Forward.module.css, not an earlier size saved for it.
    <FloatingWindow id="forward-to" open={forwardSource() !== null} class={`${chrome.dialog} ${styles.window}`} aria-label="Forward message" onClose={closeForward}>
      <WindowHeader title="Forward to" classes={chrome} closeLabel="Close" onClose={closeForward} />
      <form class={styles.form} onSubmit={(e) => void send(e)}>
        <div class={styles.pick}>
          <label class={styles.search}>
            <Icon name="search" class={styles.searchIcon} />
            <input
              class={styles.searchField}
              type="search"
              placeholder="Search channels and direct messages"
              aria-label="Search channels and direct messages"
              aria-controls={LIST_ID}
              aria-activedescendant={targets()[nav.active()] ? optionId(targets()[nav.active()]!) : undefined}
              value={query()}
              onInput={(e) => setQuery(e.currentTarget.value)}
              onKeyDown={nav.onKey}
              disabled={busy()}
              autofocus
            />
          </label>
          <ul id={LIST_ID} class={styles.targets} role="listbox" aria-label="Forward to" ref={list}>
            <For each={targets()} fallback={<li class={styles.empty}>No channel or direct message matches “{query().trim()}”.</li>}>
              {(t, i) => (
                <li
                  id={optionId(t)}
                  class={styles.target}
                  role="option"
                  aria-selected={chosen() === t.channel.id}
                  aria-disabled={busy()}
                  data-active={nav.active() === i()}
                  onClick={() => pick(t)}
                >
                  <TargetAvatar target={t} />
                  <span class={styles.names}>
                    <span class={styles.name}>
                      <Show when={!DM_CHANNEL_TYPES.has(t.channel.kind)}>
                        <span class={styles.sigil} aria-hidden="true">
                          #
                        </span>
                      </Show>
                      {t.channel.name}
                    </span>
                    <span class={styles.place}>{t.guildName}</span>
                  </span>
                  <span class={styles.radio} aria-hidden="true" />
                </li>
              )}
            </For>
          </ul>
        </div>
        <div class={styles.compose}>
          <Show when={forwardSource()}>{(m) => <Preview message={m()} />}</Show>
          <textarea
            class={styles.note}
            placeholder={chosenTarget() ? `Add a message for ${chosenTarget()!.channel.name} (optional)` : 'Add a message (optional)'}
            aria-label="Message"
            rows={2}
            maxLength={DISCORD_TEXT_MAX}
            value={note()}
            disabled={busy()}
            onInput={(e) => setNote(e.currentTarget.value)}
          />
          <Show when={error()}>
            <p class={`cp-error ${styles.error}`} role="alert">
              {error()}
            </p>
          </Show>
          <div class={styles.actions}>
            <button type="button" class={`cp-button ${styles.button}`} onClick={closeForward}>
              Cancel
            </button>
            <button type="submit" class={`cp-primary ${styles.button}`} disabled={busy() || !chosenTarget()}>
              <Icon name="forward" class={styles.submitIcon} />
              {busy() ? 'Forwarding…' : 'Forward'}
            </button>
          </div>
        </div>
      </form>
    </FloatingWindow>
  );
}

/**
 * A server channel shows its server's icon; a DM its other person's avatar, else their initial; a group DM its own icon,
 * else a group mark (Discord's default group icons ship inside its client, not on its CDN).
 */
function TargetAvatar(props: { target: ForwardTarget }) {
  const c = () => props.target.channel;
  const guild = () => directory().find((g) => g.id === c().guildId);
  const [iconFailed, setIconFailed] = createSignal(false);
  return (
    <span class={styles.avatar} aria-hidden="true">
      <Switch fallback={<span class={styles.initial}>{[...c().name][0]}</span>}>
        <Match when={c().peer}>{(p) => <img class={styles.face} src={avatarUrl(p().id, p().avatar)} alt="" loading="lazy" />}</Match>
        <Match when={c().kind === GROUP_DM_CHANNEL_TYPE && c().icon && !iconFailed()}>
          <img class={styles.face} src={groupIconUrl(c().id, c().icon!)} alt="" loading="lazy" onError={() => setIconFailed(true)} />
        </Match>
        <Match when={c().kind === GROUP_DM_CHANNEL_TYPE}>
          <span class={styles.initial}>
            <Icon name="group" class={styles.groupMark} />
          </span>
        </Match>
        <Match when={!DM_CHANNEL_TYPES.has(c().kind) && guild()}>{(g) => <GuildIcon id={g().id} name={g().name} icon={g().icon} />}</Match>
      </Switch>
    </span>
  );
}

/** The message being forwarded, as a quoted card: author, time, its text (clamped) and what it carries. */
function Preview(props: { message: ArchiveMessage }) {
  const m = () => props.message;
  const extras = (): string[] => {
    const n = m().attachments.length;
    return [n ? `${n} attachment${n === 1 ? '' : 's'}` : '', m().embeds.length && !m().content ? 'Link preview' : ''].filter(Boolean);
  };
  return (
    <figure class={styles.preview}>
      <figcaption class={styles.previewHead}>
        <img class={styles.previewAvatar} src={avatarUrl(m().author.id, m().author.avatar)} alt="" loading="lazy" />
        <span class={styles.previewAuthor}>{m().author.name}</span>
        <time class={styles.previewTime} dateTime={new Date(m().ts).toISOString()}>
          {messageTime(m().ts, today())}
        </time>
      </figcaption>
      <Show when={m().content}>
        <p class={styles.previewText}>{m().content}</p>
      </Show>
      <Show when={extras().length}>
        <span class={styles.previewExtras}>{extras().join(' · ')}</span>
      </Show>
    </figure>
  );
}
