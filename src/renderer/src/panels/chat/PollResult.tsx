// A poll's closing notice, as Discord draws it: "<author>'s poll <question> has closed.", then a card with the winning
// answer (its emoji, text and share) and View Poll, which opens the poll's message.
import { Show } from 'solid-js';
import type { ArchiveMessage } from '@shared/contract';
import type { ArchivePollResult } from '@shared/polls';
import { openArchive } from '@/state/archive';
import { Icon } from '@/ui/icons';
import { ChatEmoji } from '@/views/settings/DoubleTapEmoji';
import { PersonName } from './PersonName';
import styles from './PollResult.module.css';

const PERCENT = 100;

export function PollResult(props: { message: ArchiveMessage }) {
  const r = (): ArchivePollResult => props.message.pollResult!;
  const share = (votes: number): number => (r().totalVotes ? Math.round((votes / r().totalVotes) * PERCENT) : 0);
  return (
    <section class={styles.result} aria-label={`Poll closed: ${r().question}`}>
      <p class={styles.line}>
        <PersonName userId={props.message.author.id} channelId={props.message.channelId} fallback={props.message.author.name} />
        ’s poll <strong class={styles.question}>{r().question}</strong> has closed.
      </p>
      <div class={styles.card}>
        <Show when={r().winner} fallback={<span class={styles.none}>{r().totalVotes ? 'No winning answer' : 'No votes'}</span>}>
          {(w) => (
            <>
              <span class={styles.tile} aria-hidden="true">
                <Show when={w().emoji} fallback={<Icon name="poll" class={styles.tileIcon} />}>
                  {(e) => <ChatEmoji emoji={e()} />}
                </Show>
              </span>
              <span class={styles.text}>
                <span class={styles.answer}>
                  {w().text}
                  <span class={styles.check} title="Winning answer">
                    <Icon name="check" class={styles.checkIcon} />
                  </span>
                </span>
                <span class={styles.meta}>Winning answer · {share(w().votes)}%</span>
              </span>
            </>
          )}
        </Show>
        <Show when={r().pollMessageId}>
          {(id) => (
            <button type="button" class={`cp-button ${styles.view}`} onClick={() => void openArchive(props.message.channelId, id())}>
              View Poll
            </button>
          )}
        </Show>
      </div>
    </section>
  );
}
