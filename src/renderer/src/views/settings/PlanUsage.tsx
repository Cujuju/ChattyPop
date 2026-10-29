// Settings → AI: a provider's plan windows as meters of what is left, as the Plan usage panel draws them.
import { For, Show } from 'solid-js';
import type { PlanUsageWindow } from '@shared/contract';
import type { ProviderId } from '@shared/settings';
import { timeFormat } from '@shared/hourCycle';
import { MS_PER_DAY } from '@shared/units';
import { planUsageFailureOf, planUsageLoadingOf, planUsageOf, refetchPlanUsage } from '@/state/providerUsage';
import { look } from '@/theme/look';
import { planRemainingPercent, planRemainingText } from '@/ui/format';
import { Row, SettingsButton } from './SettingsLayout';
import styles from './PlanUsage.module.css';

const PERCENT_MAX = 100;
/** Room left at or below this share reads as low (the Plan usage panel warns at 80% used). */
const PLAN_LOW_LEFT_PERCENT = 20;

const low = (w: PlanUsageWindow): boolean => (planRemainingPercent(w) ?? PERCENT_MAX) <= PLAN_LOW_LEFT_PERCENT;

/** "Resets 10:39 PM" within a day, else "Resets Wed 10:39 PM"; empty without a reset time. */
function resetText(w: PlanUsageWindow): string {
  if (!w.resetsAt) return '';
  const at = new Date(w.resetsAt);
  const soon = at.getTime() - Date.now() < MS_PER_DAY;
  return `Resets ${timeFormat(soon ? { hour: 'numeric', minute: '2-digit' } : { weekday: 'short', hour: 'numeric', minute: '2-digit' }).format(at)}`;
}

/** Why provider `id` shows no meters: failed, no limits, or first read pending; undefined once it has windows. */
function statusOf(id: ProviderId): { text: string; error: boolean } | undefined {
  const why = planUsageFailureOf(id);
  if (why) return { text: `Unavailable: ${why}`, error: true };
  const windows = planUsageOf(id);
  if (windows === null) return { text: 'No plan limits reported.', error: false };
  return windows?.length ? undefined : { text: 'Reading…', error: false };
}

/** A provider's plan windows: label, a bar of what is left, the share left and when it resets. Read on first show. */
export function PlanUsage(props: { id: ProviderId }) {
  return (
    <Row
      label="Plan usage"
      control={
        <SettingsButton disabled={planUsageLoadingOf(props.id)} onClick={() => refetchPlanUsage(props.id)}>
          {planUsageLoadingOf(props.id) ? 'Checking…' : 'Refresh'}
        </SettingsButton>
      }
    >
      <Show when={statusOf(props.id)}>
        {(st) => (
          <p class={st().error ? 'cp-error' : look.text} data-size="xs" data-tone={st().error ? undefined : 'muted'}>
            {st().text}
          </p>
        )}
      </Show>
      <Show when={planUsageOf(props.id)?.length}>
        <div class={styles.windows} data-section="provider">
          <For each={planUsageOf(props.id) ?? []}>
            {(w) => (
              <div class={styles.window}>
                <span class={`${styles.label} ${look.text}`} data-size="xs" data-weight="medium" data-tone="secondary">
                  {w.label}
                </span>
                <meter
                  class={`${styles.bar} ${look.meter}`}
                  min={0}
                  max={PERCENT_MAX}
                  low={PLAN_LOW_LEFT_PERCENT}
                  optimum={PERCENT_MAX}
                  value={planRemainingPercent(w) ?? 0}
                  aria-label={`${w.label}: ${planRemainingText(w)}`}
                />
                <span class={`${styles.value} ${look.text}`} data-size="xs" data-weight="semibold" data-figures="tabular" data-tone={low(w) ? 'accent' : 'primary'}>
                  {planRemainingText(w)}
                </span>
                <span class={`${styles.reset} ${look.text}`} data-size="xs" data-tone="muted">
                  {resetText(w)}
                </span>
                <Show when={w.note}>
                  {(n) => (
                    <span class={`${styles.note} ${look.text}`} data-size="xs" data-tone="muted">
                      {n()}
                    </span>
                  )}
                </Show>
              </div>
            )}
          </For>
        </div>
      </Show>
    </Row>
  );
}
