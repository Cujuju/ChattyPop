import { Show, createResource, createSignal } from 'solid-js';
import { JEV_RERUN_MAX, type JevQueryDef, type JevRerunRequest, type JevRerunResult } from '@shared/jevQueries';
import { MS_PER_DAY } from '@shared/units';
import { archivedChannels, channelLabel } from '@/state/directory';
import { jevRerun, jevRerunCount } from '@/state/jevQueries';
import { projectedJevUsd } from '@/state/jevSpend';
import { createAction } from '@/ui/action';
import { errorText, localRange, toLocalInput, usdText } from '@/ui/format';
import { Select } from '@/ui/Select';
import settings from './Settings.module.css';
import styles from './JevRerun.module.css';
import { look } from '@/theme/look';

/** Select value for every archived channel. */
const ALL = '';

/** Re-asks a per-message query about past messages in a channel (or all) and time range, with a cost estimate first. */
export function JevRerun(props: { def: JevQueryDef }) {
  // Jev sends text to a hosted model, so local-AI-only channels are left out.
  const channels = () => [
    { value: ALL, label: 'All archived channels' },
    ...archivedChannels({ hostedAi: true }).map((c) => ({ value: c.id, label: channelLabel(c, c.guildName) })),
  ];
  const [channelId, setChannelId] = createSignal(ALL);
  const [from, setFrom] = createSignal(toLocalInput(Date.now() - MS_PER_DAY));
  const [to, setTo] = createSignal(toLocalInput(Date.now()));
  const [result, setResult] = createSignal<JevRerunResult | null>(null);
  const action = createAction();
  const { busy, error } = action;

  const request = (): JevRerunRequest | null => {
    const range = localRange(from(), to());
    return range ? { queryId: props.def.id, channelId: channelId() || null, ...range } : null;
  };
  const [count] = createResource(request, jevRerunCount);
  /** The count, undefined while unknown or failed (reading a failed resource throws). */
  const counted = (): number | undefined => (count.error ? undefined : count());

  const run = async (): Promise<void> => {
    const r = request();
    if (!r) return;
    setResult(null);
    const done = await action.run(() => jevRerun(r));
    if (done) setResult(done);
  };

  return (
    <div class={`cp-condition ${look.card}`}>
      <span class="cp-stat-label">Run on past messages</span>
      <Select class={settings.input} value={channelId()} options={channels()} label="Channel" onChange={setChannelId} />
      <div class={styles.inline}>
        <input class={settings.input} type="datetime-local" aria-label="From" value={from()} onInput={(e) => setFrom(e.currentTarget.value)} />
        <span class="cp-hint">to</span>
        <input class={settings.input} type="datetime-local" aria-label="To" value={to()} onInput={(e) => setTo(e.currentTarget.value)} />
      </div>
      <p class="cp-hint">
        {count.loading ? 'Counting…' : count.error ? errorText(count.error) : `${counted() ?? 0} messages ≈ ${usdText(projectedJevUsd(counted() ?? 0))}`} (at most{' '}
        {JEV_RERUN_MAX} per run; matching by meaning asks once per rule by meaning). Answers are stored and acted on as for new messages; alerts from old
        messages land already read.
      </p>
      <Show when={error()}>
        <p class="cp-error" role="alert">
          {error()}
        </p>
      </Show>
      <Show when={result()}>
        {(r) => (
          <p class="cp-hint" role="status">
            Asked about {r().asked} messages{r().failed ? `, ${r().failed} failed` : ''}
            {r().costUsd !== null ? ` · ${usdText(r().costUsd!)}` : ''}.
          </p>
        )}
      </Show>
      <div class={styles.actions}>
        <button type="button" class={`cp-button ${settings.button}`} disabled={busy() || !counted()} onClick={() => void run()}>
          {busy() ? 'Running…' : 'Run'}
        </button>
      </div>
    </div>
  );
}
