import { For, Show, createEffect } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { pluginWindowView } from '@/plugins/slots';
import { closeWindow, openPluginWindows, pluginWindowId, pluginWindowKind, type PluginWindowRef } from '@/state/pluginWindows';
import { FloatingWindow, WindowHeader } from '@/ui/FloatingWindow';
import chrome from '@/ui/WindowChrome.module.css';

function PluginWindow(props: { of: PluginWindowRef }) {
  const view = () => pluginWindowView(props.of.plugin, props.of.window);
  const titleId = `${pluginWindowId(props.of)}-title`;
  const close = (): void => closeWindow(props.of);
  // A plugin that turned off takes its windows with it.
  createEffect(() => {
    if (!view()) close();
  });
  return (
    <FloatingWindow id={pluginWindowId(props.of)} geometryKey={pluginWindowKind(props.of)} open={!!view()} class={chrome.dialog} aria-labelledby={titleId} onClose={close}>
      <Show when={view()}>
        {(v) => (
          <>
            <WindowHeader title={<Dynamic component={v().title} key={props.of.key} />} titleId={titleId} classes={chrome} closeLabel="Close window" onClose={close} />
            {/* Structural frame only: the plugin's view fills the window below its title bar and owns its scrolling. */}
            <div data-section="plugin" style={{ display: 'flex', 'flex-direction': 'column', flex: '1 1 0', 'min-height': 0 }}>
              <Dynamic component={v().view} key={props.of.key} />
            </div>
          </>
        )}
      </Show>
    </FloatingWindow>
  );
}

/** Plugins' in-app windows, one per open key (openPluginWindow); the main window only. */
export function PluginWindows() {
  return <For each={openPluginWindows()}>{(w) => <PluginWindow of={w} />}</For>;
}
