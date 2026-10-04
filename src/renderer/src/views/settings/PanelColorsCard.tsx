// Settings → Appearance → Panel colours: the owner's colour for each panel; its header and toolbar button wear it.
import { createMemo, For, Show } from 'solid-js';
import { appearanceSettings, patchAppearanceSettings, themeApplied } from '@/state/preferences';
import { panelOrder, titleOf } from '@/layout/panelMenu';
import { panelIdentity, sectionOf } from '@/panels/titles';
import { pluginPanels } from '@/state/pluginPanels';
import { themeSectionColor } from '@/theme/panelColors';
import { SectionIcon } from '@/ui/SectionIcon';
import { Card, Row, SettingsButton, settingsControl as c } from './SettingsLayout';
import { ColorField } from './ColorField';
import styles from './AppearanceSection.module.css';

/** The status bar is the one panel with no section colour. */
const UNCOLORED_PANELS: ReadonlySet<string> = new Set(['status-bar']);

/** Sets or (null) clears a panel's colour; `themeColor` is what it wears without one, so choosing that clears it too. */
const setPanelColor = (id: string, hex: string | null, themeColor?: string): void => {
  const { [id]: _old, ...rest } = appearanceSettings().panelColors;
  patchAppearanceSettings({ panelColors: hex && hex !== themeColor ? { ...rest, [id]: hex } : rest });
};

export function PanelColorsCard() {
  const panels = (): string[] => [...panelOrder().filter((id) => !UNCOLORED_PANELS.has(id)), ...pluginPanels().map((p) => p.layoutId)];
  // The theme's own colours, re-read from the DOM each time applyTheme has finished wearing a theme.
  const themeColors = createMemo(() => {
    themeApplied();
    return Object.fromEntries(panels().map((id) => [id, themeSectionColor(document.documentElement, sectionOf(id))]));
  });
  return (
    <Card title="Panel colours">
      <For each={panels()}>
        {(id) => {
          const own = (): string | undefined => appearanceSettings().panelColors[id];
          return (
            <Row
              label={
                <span class={styles.panelName} {...panelIdentity(id)}>
                  <SectionIcon section={sectionOf(id)} />
                  {titleOf(id)}
                </span>
              }
              control={
                <div class={c.buttons}>
                  <ColorField label={`${titleOf(id)} colour`} value={own() ?? themeColors()[id] ?? ''} onChange={(hex) => setPanelColor(id, hex, themeColors()[id])} />
                  <Show when={own()}>
                    <SettingsButton onClick={() => setPanelColor(id, null)}>Theme colour</SettingsButton>
                  </Show>
                </div>
              }
            />
          );
        }}
      </For>
    </Card>
  );
}
