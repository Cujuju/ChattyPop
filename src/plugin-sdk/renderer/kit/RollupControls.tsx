import { Show, createSignal } from 'solid-js';
import { onAppEvent } from '../appEvents';
import { onCleanup } from '../containment';
import type { PluginResource } from '../resource';
import type { RollupStatus } from '@shared/rollups';
import { HeaderButton, HeaderMeta } from '@/ui/PanelHeader';

/** Shared status and owner rebuild action; the caller owns its audience-aware resource and scope. */
export function RollupControls(props: {
  pluginId: string;
  status: PluginResource<RollupStatus>;
  rebuild(): Promise<unknown>;
  canRebuild?: boolean;
  label: string;
  title: string;
  onRebuilt?: () => unknown;
}) {
  const [error, setError] = createSignal<string | null>(null);
  let pending = false;
  onCleanup(onAppEvent('rollup-progress', (event) => {
    if (event.pluginId !== props.pluginId) return;
    pending ||= event.building;
    void props.status.refetch().then(async () => {
      if (pending && !props.status().building && !props.status.loading && !props.status.failure) {
        pending = false;
        await props.onRebuilt?.();
      }
    }).catch((e) => setError(String(e)));
  }));
  const rebuild = async () => {
    setError(null);
    pending = true;
    try { await props.rebuild(); await props.status.refetch(); }
    catch (e) { pending = false; setError(String(e)); }
  };
  return <>
    <Show when={props.status().building}><HeaderMeta>Updating {props.label}…</HeaderMeta></Show>
    <Show when={props.status().error || props.status.failure || error()}>
      <HeaderMeta title={props.status().error ?? props.status.failure ?? error() ?? undefined}>{props.label} need attention</HeaderMeta>
    </Show>
    <Show when={props.canRebuild !== false}>
      <HeaderButton title={props.title} disabled={props.status().building && !props.status().error} onClick={() => void rebuild()}>Rebuild {props.label}</HeaderButton>
    </Show>
  </>;
}
