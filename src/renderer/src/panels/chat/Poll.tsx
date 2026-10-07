// A message's Discord poll, as Discord shows it: pick answers and Vote while it runs; once voted (or ended), each answer's share.
import { For, Show, createSignal } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import { pollTimeLeft, type ArchivePoll } from '@shared/polls';
import { now } from '@/state/clock';
import { pollOpen, votePoll } from '@/state/polls';
import { EmojiImage } from '@/ui/AnimatedImage';
import { errorText } from '@/ui/format';
import styles from './Poll.module.css';

const PERCENT = 100;

export function Poll(props: { message: ArchiveMessage }) {
  const poll = (): ArchivePoll => props.message.poll!;
  const [picked, setPicked] = createSignal<number[]>([]);
  // Results asked for before voting (Discord's Show results).
  const [peeking, setPeeking] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const open = (): boolean => pollOpen(props.message, poll(), now());
  const voted = (): boolean => poll().answers.some((a) => a.mine);
  const showResults = (): boolean => !open() || voted() || peeking();
  const total = (): number => poll().answers.reduce((n, a) => n + a.votes, 0);
  const share = (votes: number): number => (total() ? votes / total() : 0);

  const pick = (id: number): void => void
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : poll().multiselect ? [...p, id] : [id]));
  const vote = (answerIds: number[]): void => {
    setBusy(true);
    setError(null);
    votePoll(props.message, answerIds)
      .then(() => {
        setPicked([]);
        setPeeking(false);
      })
      .catch((err: unknown) => setError(errorText(err)))
      .finally(() => setBusy(false));
  };
  const footer = (): string => {
    const votes = `${total()} ${total() === 1 ? 'vote' : 'votes'}`;
    const end = poll().expiresAt;
    const left = end === null ? null : pollTimeLeft(end, now());
    return open() ? (left ? `${votes} · ${left}` : votes) : `${votes} · Poll closed`;
  };

  return (
    <section class={styles.poll} aria-label={`Poll: ${poll().question}`}>
      <p class={styles.question}>{poll().question}</p>
      <p class={styles.hint}>{showResults() ? (open() ? 'Results so far' : 'Final results') : poll().multiselect ? 'Select one or more answers' : 'Select one answer'}</p>
      <div class={styles.answers} role={showResults() ? 'list' : 'group'}>
        <For each={poll().answers}>
          {(a) => (
            <Show
              when={!showResults()}
              fallback={
                <div class={styles.answer} role="listitem" data-mine={a.mine} style={{ '--v': share(a.votes) }}>
                  <span class={styles.fill} aria-hidden="true" />
                  <AnswerText emoji={a.emoji} text={a.text} />
                  <span class={styles.count}>
                    {Math.round(share(a.votes) * PERCENT)}% · {a.votes}
                  </span>
                </div>
              }
            >
              <button
                type="button"
                class={styles.answer}
                role={poll().multiselect ? 'checkbox' : 'radio'}
                aria-checked={picked().includes(a.id)}
                disabled={busy()}
                onClick={() => pick(a.id)}
              >
                <AnswerText emoji={a.emoji} text={a.text} />
                <span class={styles.mark} data-shape={poll().multiselect ? 'box' : 'round'} aria-hidden="true" />
              </button>
            </Show>
          )}
        </For>
      </div>
      <div class={styles.footer}>
        <span class={styles.meta}>{footer()}</span>
        <Show when={open()}>
          <Show
            when={showResults()}
            fallback={
              <>
                <button type="button" class={styles.link} onClick={() => setPeeking(true)}>
                  Show results
                </button>
                <button type="button" class={styles.vote} disabled={busy() || !picked().length} onClick={() => vote(picked())}>
                  Vote
                </button>
              </>
            }
          >
            <Show when={voted()} fallback={<button type="button" class={styles.link} onClick={() => setPeeking(false)}>Go back to vote</button>}>
              <button type="button" class={styles.link} disabled={busy()} onClick={() => vote([])}>
                Remove vote
              </button>
            </Show>
          </Show>
        </Show>
      </div>
      <Show when={error()}>
        <p class="cp-error" role="alert">
          {error()}
        </p>
      </Show>
    </section>
  );
}

function AnswerText(props: { emoji: ArchivePoll['answers'][number]['emoji']; text: string }) {
  return (
    <span class={styles.answerText}>
      <Show when={props.emoji}>
        {(e) => (
          <Show when={e().id} fallback={<span>{e().name}</span>}>
            {(id) => <EmojiImage class={styles.emoji} emoji={{ id: id(), animated: e().animated }} alt={`:${e().name}:`} loading="lazy" />}
          </Show>
        )}
      </Show>
      <span>{props.text}</span>
    </span>
  );
}
