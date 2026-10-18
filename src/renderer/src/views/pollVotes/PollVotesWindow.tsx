// A poll's votes (View votes), as Discord's: its answers down the side (emoji, answer, its count), the chosen answer's
// voters beside them (avatar, name over username), read from Discord a page at a time. Each voter opens their profile.
import { For, Show, createEffect, createSignal, on } from 'solid-js';
import type { PersonMatch } from '@shared/contract';
import { openPerson } from '@/state/person';
import { closePollVotes, pollVotersPage, pollVotesOf } from '@/state/polls';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import { errorText } from '@/ui/format';
import chrome from '@/ui/WindowChrome.module.css';
import { AuthorName } from '@/panels/chat/AuthorName';
import { PersonFace, drawnName } from '@/panels/chat/PersonName';
import { ChatEmoji } from '@/views/settings/DoubleTapEmoji';
import { look } from '@/theme/look';
import styles from './PollVotes.module.css';

export function PollVotesWindow() {
  const [answerId, setAnswerId] = createSignal<number | null>(null);
  const [voters, setVoters] = createSignal<PersonMatch[]>([]);
  const [next, setNext] = createSignal<string | null>(null);
  const [loading, setLoading] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  /** The latest request: a page for an answer no longer shown is dropped. */
  let asked = 0;

  const load = (after: string | null): void => {
    const p = pollVotesOf();
    const id = answerId();
    if (!p || id === null) return;
    const request = ++asked;
    setLoading(true);
    setError(null);
    pollVotersPage(p, id, after)
      .then((page) => {
        if (request !== asked) return;
        setVoters((shown) => (after ? [...shown, ...page.people] : page.people));
        setNext(page.next);
      })
      .catch((err: unknown) => request === asked && setError(errorText(err)))
      .finally(() => request === asked && setLoading(false));
  };

  // A poll opens on its first answer with votes, as Discord's does.
  createEffect(on(pollVotesOf, (p) => setAnswerId(p ? ((p.answers.find((a) => a.votes > 0) ?? p.answers[0])?.id ?? null) : null)));
  createEffect(
    on([pollVotesOf, answerId], () => {
      setVoters([]);
      setNext(null);
      load(null);
    }),
  );
  const channelId = (): string | null => pollVotesOf()?.channelId ?? null;
  const status = (): string => (loading() ? 'Loading…' : error() ? '' : 'No votes for this answer.');

  return (
    <FloatingWindow id="pollVotes" open={pollVotesOf() !== null} class={`${chrome.dialog} ${styles.window}`} aria-label="Poll votes" onClose={closePollVotes}>
      <WindowHeader title="Poll votes" classes={chrome} closeLabel="Close" onClose={closePollVotes} />
      <p class={styles.question}>{pollVotesOf()?.question}</p>
      <div class={styles.columns}>
        <nav class={styles.answers} aria-label="Answers">
          <For each={pollVotesOf()?.answers ?? []}>
            {(a) => (
              <button type="button" class={`${styles.answer} ${look.navItem}`} aria-current={answerId() === a.id ? 'page' : undefined} onClick={() => setAnswerId(a.id)}>
                <Show when={a.emoji}>{(e) => <ChatEmoji emoji={e()} />}</Show>
                <span class={styles.answerText}>
                  {a.text} <span class={styles.count}>({a.votes})</span>
                </span>
              </button>
            )}
          </For>
        </nav>
        <section class={styles.voters} aria-label="Voters" aria-busy={loading()}>
          <Show when={voters().length} fallback={<p class={styles.status}>{status()}</p>}>
            <ul class={styles.list}>
              <For each={voters()}>
                {(person) => (
                  <li>
                    <button type="button" class={`${styles.voter} ${look.row}`} data-hover="raise" onClick={() => openPerson(person.id, channelId())}>
                      <PersonFace userId={person.id} channelId={channelId()} class={styles.face} />
                      <span class={styles.names}>
                        <AuthorName author={drawnName(person.id, channelId(), person.name)} class={styles.name} />
                        <Show when={person.username}>{(u) => <span class={styles.username}>{u()}</span>}</Show>
                      </span>
                    </button>
                  </li>
                )}
              </For>
            </ul>
          </Show>
          <Show when={error()}>
            <p class="cp-error" role="alert">
              {error()}
            </p>
          </Show>
          <Show when={next() && !loading()}>
            <button type="button" class={`cp-button ${styles.more}`} onClick={() => load(next())}>
              Show more
            </button>
          </Show>
        </section>
      </div>
    </FloatingWindow>
  );
}
