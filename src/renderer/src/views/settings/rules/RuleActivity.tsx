import { ruleActivity } from '@/plugins/slots';
import { For, Show } from 'solid-js';
import { actionInfo, type Rule, type RuleRun } from '@shared/rules';
import { openArchive } from '@/state/archive';
import { channelById, channelSigil } from '@/state/directory';
import { ruleRuns } from '@/state/rules';
import { countText, shortDateTime } from '@/ui/format';
import { InlineMarkdown } from '@/ui/Markdown';
import { Step } from './fields';
import styles from './Rules.module.css';

const OUTCOME_MARK = { done: '✓', skipped: 'skipped', failed: 'failed' } as const;

/** The run's channel with its kind's sigil; `#` when the channel left the directory. */
function runChannel(r: RuleRun): string | null {
  if (!r.channelName) return null;
  const ch = r.channelId ? channelById(r.channelId) : undefined;
  return `${ch ? channelSigil(ch) : '#'}${r.channelName}`;
}

/** Where the message was and how it began: "#general · stat: “my vape died…”", its Discord markup drawn. */
function RunWhat(props: { run: RuleRun }) {
  const r = () => props.run;
  return (
    <>
      {runChannel(r())}
      <Show
        when={r().authorName !== null && r().snippet !== null}
        fallback={r().messageId ? `${runChannel(r()) ? ' · ' : ''}Message no longer archived` : 'On schedule'}
      >
        {runChannel(r()) ? ' · ' : ''}
        {r().authorName}: “<InlineMarkdown text={r().snippet!} mentions={r().mentions} inert />”
      </Show>
    </>
  );
}

/** The open rule's recent runs, newest first: each action's outcome; a run opens its message in the Archive. */
export function RuleActivity(props: { rule: Rule }) {
  const summary = (): string =>
    [
      countText(props.rule.fired, 'run'),
      props.rule.lastFiredAt ? `last ${shortDateTime(props.rule.lastFiredAt)}` : null,
      ...ruleActivity(props.rule),
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <Step title="Recent runs" note={summary()}>
      <div class={styles.card}>
        <Show
          when={ruleRuns().length}
          fallback={
            <p class={styles.empty}>No runs yet.</p>
          }
        >
          <table class={styles.runs}>
            <tbody>
              <For each={ruleRuns()}>
                {(r) => (
                  <tr>
                    <td class={styles.runWhen}>{shortDateTime(r.at)}</td>
                    <td class={styles.runWhat}>
                      <Show when={r.channelId && r.messageId} fallback={<RunWhat run={r} />}>
                        <button
                          type="button"
                          class={styles.runOpen}
                          title="Show the message in the Archive"
                          onClick={() => void openArchive(r.channelId!, r.messageId!)}
                        >
                          <RunWhat run={r} />
                        </button>
                      </Show>
                      <Show when={!r.live}>
                        <span class={`cp-micro-tag ${styles.runTag}`}>missed</span>
                      </Show>
                    </td>
                    <td class={styles.runOutcomes}>
                      <For each={r.actions}>
                        {(a) => (
                          <span class={styles.outcome} data-outcome={a.outcome} title={a.detail ?? undefined}>
                            {actionInfo(a.kind).label} {OUTCOME_MARK[a.outcome]}
                          </span>
                        )}
                      </For>
                    </td>
                  </tr>
                )}
              </For>
            </tbody>
          </table>
        </Show>
      </div>
    </Step>
  );
}
