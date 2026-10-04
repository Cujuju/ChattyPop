// App status and shortcut hints, placed through shared contribution anchors.
import { For, Show } from 'solid-js';
import type { HostStatusBarItemId } from '@shared/anchors';
import { JEV_SPEND_RECENT_DAYS } from '@shared/jevSpend';
import { statusBarItems } from '@/plugins/slots';
import { coreStatus } from '@/state/core';
import { archivedChannels, channelLabel, syncProgress } from '@/state/directory';
import { jevSpend, jevUseRecent, jevUseToday, type JevUse } from '@/state/jevSpend';
import { now } from '@/state/clock';
import { keyLabel } from '@/state/leaderRules';
import { leaderArmed, leaderKey, shortcutHints } from '@/state/shortcuts';
import { ageLabel, captureOn, latestMessageTs } from '@/state/statusBar';
import { formatBytes, formatTokens, usdText } from '@/ui/format';
import styles from './StatusBar.module.css';
import { api } from '@/api';
import { StatusBarItem } from './StatusBarItem';
import type { StatusBarContribution } from '@/plugins/frameSlots';

/** "$0.0006 · 12.3k tok": cost, then input plus output tokens. */
const jevUseText = (u: JevUse): string => `${usdText(u.usd)} · ${formatTokens(u.inputTokens + u.outputTokens)} tok`;

/** Jev's totals, token split and rate on hover. */
const jevSpendTitle = (): string => {
  const s = jevSpend();
  if (!s) return '';
  const tokens = `
${s.inputTokens.toLocaleString()} input + ${s.outputTokens.toLocaleString()} output tokens`;
  const tokenless = s.tokenlessRequests ? ` (${s.tokenlessRequests} earlier requests have no token count)` : '';
  const rate = s.usdPerQuestion === null ? '' : `
About ${usdText(s.usdPerQuestion)} per question over the last ${JEV_SPEND_RECENT_DAYS} days`;
  const unpriced = s.unpricedRequests ? `
${s.unpricedRequests} requests came back without a price and aren't counted` : '';
  return `Jev all time ${usdText(s.totalUsd)} over ${s.requests} requests${tokens}${tokenless}${rate}${unpriced}`;
};

/** F2 status bar: capture state, backfill, disk, contributed usage, Jev spend, shortcut hints, app version; details on hover. */
export function StatusBarPanel() {
  const archived = () => archivedChannels();
  const backfilling = () => archived().filter((c) => syncProgress[c.id]?.phase === 'backfill');

  const host: readonly (StatusBarContribution & { id: HostStatusBarItemId })[] = [
    {
      id: 'capture',
      Component: () => (
        <span class={styles.item} data-state={captureOn() === null ? 'unknown' : captureOn() ? 'on' : 'off'}>
          <span class={styles.dot} aria-hidden="true" />
          {captureOn() === false ? 'capture off (sign in to Discord)' : 'capture on'} · {archived().length} ch
          <Show when={latestMessageTs()}>{(ts) => ` · last msg ${ageLabel(now() - ts())}`}</Show>
        </span>
      ),
    },
    {
      id: 'backfill',
      Component: () => (
        <Show when={backfilling().length}>
          <StatusBarItem
            label="backfill"
            value={backfilling().map((c) => `${channelLabel(c)} ${syncProgress[c.id]!.fetched}`).join(', ')}
          />
        </Show>
      ),
    },
    {
      id: 'error',
      Component: () => (
        <Show when={coreStatus.error}>
          <span class={styles.error}>Archive unavailable: {String(coreStatus.error)}</span>
        </Show>
      ),
    },
    {
      id: 'disk',
      Component: () => (
        <Show when={coreStatus()}>
          {(s) => (
            <StatusBarItem
              label="disk"
              value={formatBytes(s().totalBytes)}
              title={`Database ${formatBytes(s().dbBytes)} · attachments ${formatBytes(s().mediaBytes)}\nSQLite ${s().sqliteVersion} · schema v${s().schemaVersion} · ${s().fts5 ? 'search ready' : 'search missing'} · ${s().encrypted ? `encrypted (${s().cipher})` : 'not encrypted'}`}
            />
          )}
        </Show>
      ),
    },
    {
      id: 'jev',
      Component: () => (
        <Show when={jevSpend()?.requests}>
          <StatusBarItem label="jev today" value={jevUseText(jevUseToday(now()))} title={jevSpendTitle()}>
            {' · '}{JEV_SPEND_RECENT_DAYS}d {jevUseText(jevUseRecent(now()))}
          </StatusBarItem>
        </Show>
      ),
    },
    {
      id: 'hints',
      Component: () => (
        <span class={styles.hints} data-armed={leaderArmed()}>
          <span class={styles.hint} title={`Shortcuts: press ${keyLabel(leaderKey())}, then a key below`}>
            <kbd class={`${styles.kbd} ${styles.leader}`}>{keyLabel(leaderKey())}</kbd> then
          </span>
          <For each={shortcutHints()}>
            {(h) => (
              <span class={styles.hint}>
                <kbd class={styles.kbd}>{h.keys}</kbd> {h.hint}
              </span>
            )}
          </For>
        </span>
      ),
    },
    {
      id: 'restart',
      Component: () => (
        <button
          type="button"
          class={`cp-danger ${styles.restart}`}
          title="Restart ChattyPop: closes it gracefully, keeping your Discord login, and starts it again"
          onClick={() => void api.restartApp()}
        >
          ↻ restart
        </button>
      ),
    },
    {
      id: 'version',
      Component: () => (
        <span class={styles.version} title="ChattyPop version">
          v{__APP_VERSION__}
        </span>
      ),
    },
  ];
  return (
    <footer class={styles.root} aria-label="App status">
      <For each={statusBarItems(host)}>{(item) => <item.Component />}</For>
    </footer>
  );
}
