import { Show, createEffect, onCleanup } from 'solid-js';
import type { PluginPanelId } from '@shared/plugins';
import { openArchive } from '@/state/archive';
import { isPanelCollapsed } from '@/state/layout';
import { findPluginPanel, onArchiveChangedForPanels, pluginCall } from '@/state/pluginPanels';
import { PanelHeader } from '@/ui/PanelHeader';
import styles from './PluginPanel.module.css';

/** A plugin's panel in the layout: the shared header, then an element the plugin renders into (full trust, its own code). */
export function PluginPanelSlot(props: { id: PluginPanelId }) {
  const panel = () => findPluginPanel(props.id);
  let body: HTMLDivElement | undefined;
  createEffect(() => {
    const p = panel();
    if (!p || !body || isPanelCollapsed(props.id)) return;
    const el = body;
    let cleanup: void | (() => void);
    try {
      cleanup = p.mount(el, {
        pluginId: p.pluginId,
        call: (name, ...args) => pluginCall(p.pluginId, name, args),
        openMessage: (channelId, messageId) => void openArchive(channelId, messageId),
        onArchiveChanged: onArchiveChangedForPanels,
      });
    } catch (err) {
      el.textContent = `This panel failed to start: ${err instanceof Error ? err.message : String(err)}`;
    }
    onCleanup(() => {
      if (typeof cleanup === 'function') cleanup();
      el.replaceChildren();
    });
  });
  return (
    <section class={styles.root} aria-label={panel()?.title ?? 'Plugin panel'}>
      <PanelHeader section="plugin" panelId={props.id} collapsible title={panel()?.title ?? props.id} />
      <Show when={!isPanelCollapsed(props.id)}>
        <Show
          when={panel()}
          fallback={<p class={styles.missing}>This plugin panel isn't available: its plugin is off, removed, or failed to load (Settings → Plugins).</p>}
        >
          <div ref={body} class={styles.body} />
        </Show>
      </Show>
    </section>
  );
}
