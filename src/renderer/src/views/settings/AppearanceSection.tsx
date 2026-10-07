// Host presentation with active feature wording.
import { appearanceText } from '@/plugins/presentation';
import { For, Show } from 'solid-js';
import { CUSTOM_BASE_THEME, THEME_IDS, THEME_LABELS, type ThemeId } from '@shared/settings';
import { customThemeTokens, gradientImage } from '@/theme/customTheme';
import type { CustomTheme } from '@shared/settings';
import { appearanceSettings, patchAppearanceSettings } from '@/state/preferences';
import { archiveDensity, setArchiveDensity, type ArchiveDensity } from '@/state/archive';
import { inCompanion } from '@/state/ui';
import { Select } from '@/ui/Select';
import { Card, Note, Page, Row, settingsControl as c } from './SettingsLayout';
import { CustomThemeCard } from './CustomThemeCard';
import { PanelColorsCard } from './PanelColorsCard';
import styles from './AppearanceSection.module.css';

/** What each theme is, as the picker describes it. */
const THEME_HINTS = (): Record<ThemeId, string> => ({
  night: 'Navy-slate with an amber accent. Every panel carries equal weight.',
  spotlight: appearanceText().spotlight,
  tide: appearanceText().tide,
  paper: 'Light. Warm off-white with near-black ink and Atkinson Hyperlegible type, a step larger: long reading, little glare.',
  daylight: 'Light. Cool white with crisp, extra-dark text in Segoe UI, a step larger: bright rooms and small type.',
  custom: 'Your own gradient, or the custom theme you set in Discord. Set it up below.',
});

/** The custom theme's preview: its tokens, and its gradient under the panel veil (--cp-custom-gradient). */
const customPreviewStyle = (t: CustomTheme): Record<string, string> => ({ ...customThemeTokens(t), '--cp-custom-gradient': gradientImage(t) });

/** The Archive's message layouts, as the picker names them. */
const DENSITIES: { value: ArchiveDensity; label: string }[] = [
  { value: 'cozy', label: 'Cozy: avatars, grouped by author' },
  { value: 'compact', label: 'Compact: one line per message' },
];

/** Settings → Appearance: the app theme and the Archive's layout. Each option previews its own colours and type (data-theme scopes the tokens). */
export function AppearanceSection() {
  return (
    <Page id="appearance" title="Appearance" lede="How the app looks. A theme applies to every window right away.">
      <Show when={inCompanion}>
        <Note>This phone's theme and layout: Settings → Look</Note>
      </Show>
      <Show when={!inCompanion}>
        <Card title="Theme">
          <div class={`${styles.themeList} ${c.cardBody}`} role="radiogroup" aria-label="Theme">
            <For each={THEME_IDS}>
              {(id) => (
                <label class={styles.themeOption}>
                  <input
                    type="radio"
                    name="theme"
                    value={id}
                    checked={appearanceSettings().theme === id}
                    onChange={() => patchAppearanceSettings({ theme: id })}
                  />
                  <span class={styles.themeText}>
                    <span class={styles.providerName}>{THEME_LABELS[id]}</span>
                    <span class="cp-hint">{THEME_HINTS()[id]}</span>
                  </span>
                  <span
                    class={styles.themePreview}
                    data-theme={id === 'custom' ? CUSTOM_BASE_THEME[appearanceSettings().custom.base] : id}
                    data-gradient={id === 'custom' ? '' : undefined}
                    style={id === 'custom' ? customPreviewStyle(appearanceSettings().custom) : undefined}
                    aria-hidden="true"
                  >
                    <span class={styles.themeSample}>Aa</span>
                    <span class={styles.themeSwatch} data-section="summary" />
                    <span class={styles.themeSwatch} data-section="alerts" />
                    <span class={styles.themeSwatch} data-section="links" />
                    <span class={styles.themeAccent} />
                  </span>
                </label>
              )}
            </For>
          </div>
        </Card>
      </Show>
      <CustomThemeCard />
      <PanelColorsCard />
      <Show when={!inCompanion}>
        <Card title="Archive">
          <Row
            label="Message layout"
            for="archive-density"
            hint="How the Archive lists messages, on this PC and on phones that don’t choose their own."
            control={
              <Select id="archive-density" class={c.select} value={archiveDensity()} options={DENSITIES} onChange={(v) => setArchiveDensity(v as ArchiveDensity)} />
            }
          />
        </Card>
      </Show>
    </Page>
  );
}
