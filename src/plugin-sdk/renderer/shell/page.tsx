// Plugin SDK, renderer shell: a plugin page's root (docs/plugin-architecture.md §3, plugin page). The build loads the
// host's bootstrap (theme, then plugin registry) before the page's entry; the registry awaits installed plugins (§16),
// so the page renders once it installs, and its views render into an installed registry.
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
