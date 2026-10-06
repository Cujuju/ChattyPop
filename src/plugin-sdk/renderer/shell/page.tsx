// Plugin pages load theme and registry bootstrap before entry. Rendering waits for installed plugin registry completion.
import type { JSX } from 'solid-js';
import { render } from 'solid-js/web';
import { rendererPluginsInstalled } from '@/plugins/installed';
import { applyTheme } from '@/state/preferences';
import type { PhoneTextSize } from '@shared/phoneLook';

/** Wears the phone's text size (its Settings): theme/phone.css keys its type ramp on html data-text-size. */
export function showPhoneTextSize(size: PhoneTextSize): void {
  document.documentElement.dataset['textSize'] = size;
}

/** Renders a plugin page's view into #root, wearing the owner's theme, once the plugin registry is installed. */
export function startPage(view: () => JSX.Element): void {
  void rendererPluginsInstalled().then(() =>
    render(() => {
      applyTheme();
      return view();
    }, document.getElementById('root')!),
  );
}
