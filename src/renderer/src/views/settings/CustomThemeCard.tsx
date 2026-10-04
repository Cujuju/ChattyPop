// Settings → Appearance → Custom gradient: the owner's gradient stops, angle, base mix and base, or Discord's import.
import { createSignal, Index, Show } from 'solid-js';
import {
  CUSTOM_THEME_MAX_COLORS,
  CUSTOM_THEME_MAX_MIX,
  CUSTOM_THEME_MIN_COLORS,
  DEGREES_PER_TURN,
  normalizeCustomTheme,
  type CustomTheme,
  type CustomThemeBase,
} from '@shared/settings';
import { errorMessage } from '@shared/errors';
import { appearanceSettings, importDiscordTheme, patchAppearanceSettings } from '@/state/preferences';
import { gradientImage } from '@/theme/customTheme';
import { Icon } from '@/ui/icons';
import { Select } from '@/ui/Select';
import { PillNumberPicker } from '@cujuju/solidjs-pill-number-picker';
import { Card, ErrorNote, Note, Row, SettingsButton, settingsControl as c } from './SettingsLayout';
import { ColorField } from './ColorField';
import styles from './AppearanceSection.module.css';

const BASES: { value: CustomThemeBase; label: string }[] = [
  { value: 'dark', label: 'Dark: light text on deep tones' },
  { value: 'light', label: 'Light: dark text on pale tones' },
];

/** The unit inside the picker's value cell; editing shows the bare number. */
const withUnit = (unit: string) => (v: number): string => `${v}${unit}`;

/** Edits wear the custom theme at once, so the owner sees each change. */
const edit = (patch: Partial<CustomTheme>): void =>
  void patchAppearanceSettings({ theme: 'custom', custom: normalizeCustomTheme({ ...appearanceSettings().custom, ...patch }) });

export function CustomThemeCard() {
  const custom = (): CustomTheme => appearanceSettings().custom;
  const [importing, setImporting] = createSignal(false);
  const [importError, setImportError] = createSignal<string | null>(null);
  const [imported, setImported] = createSignal(false);

  const runImport = async (): Promise<void> => {
    setImporting(true);
    setImportError(null);
    setImported(false);
    try {
      await importDiscordTheme();
      setImported(true);
    } catch (err) {
      setImportError(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  const setColor = (i: number, color: string): void => edit({ colors: custom().colors.map((c0, j) => (j === i ? color : c0)) });

  return (
    <Card title="Custom gradient">
      {/* Rows pad themselves; only the strip takes the card body's padding. */}
      <div class={c.cardBody}>
        <div class={styles.gradientStrip} style={{ '--cp-custom-gradient': gradientImage(custom()) }} aria-hidden="true" />
      </div>
      <Row
        label="Import from Discord"
        hint="Copies the custom theme you set in Discord: its colours, angle, base mix and dark or light base."
        control={
          <SettingsButton onClick={() => void runImport()} disabled={importing()}>
            {importing() ? 'Importing…' : 'Import'}
          </SettingsButton>
        }
      />
      <ErrorNote error={importError()} />
      <Show when={imported()}>
        <Note kind="status">Imported your Discord theme.</Note>
      </Show>
      <Row
        label="Colours"
        hint={`Gradient stops in order, ${CUSTOM_THEME_MIN_COLORS} to ${CUSTOM_THEME_MAX_COLORS}.`}
        control={
          <div class={c.buttons}>
            <Index each={custom().colors}>
              {(color, i) => (
                <span class={styles.stop}>
                  <ColorField flush label={`Colour ${i + 1}`} value={color()} onChange={(hex) => setColor(i, hex)} />
                  <Show when={custom().colors.length > CUSTOM_THEME_MIN_COLORS}>
                    <button
                      type="button"
                      class={styles.stopRemove}
                      aria-label={`Remove colour ${i + 1}`}
                      title="Remove this colour"
                      onClick={() => edit({ colors: custom().colors.filter((_, j) => j !== i) })}
                    >
                      <Icon name="close" />
                    </button>
                  </Show>
                </span>
              )}
            </Index>
            <Show when={custom().colors.length < CUSTOM_THEME_MAX_COLORS}>
              <SettingsButton onClick={() => edit({ colors: [...custom().colors, custom().colors.at(-1)!] })}>Add colour</SettingsButton>
            </Show>
          </div>
        }
      />
      <Row
        label="Angle"
        control={<PillNumberPicker ariaLabel="Angle" min={0} max={DEGREES_PER_TURN - 1} value={custom().angle} displayValue={withUnit('°')} onChange={(angle) => edit({ angle })} />}
      />
      <Row
        label="Base mix"
        hint="How much of the base colour covers the gradient. Raised automatically where text would be hard to read."
        control={<PillNumberPicker ariaLabel="Base mix" min={0} max={CUSTOM_THEME_MAX_MIX} value={custom().baseMix} displayValue={withUnit('%')} onChange={(baseMix) => edit({ baseMix })} />}
      />
      <Row
        label="Base"
        for="custom-theme-base"
        control={<Select id="custom-theme-base" class={c.select} value={custom().base} options={BASES} onChange={(v) => edit({ base: v as CustomThemeBase })} />}
      />
    </Card>
  );
}
