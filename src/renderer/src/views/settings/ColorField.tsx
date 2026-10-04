// A colour control for Settings: the owner's colour picker, themed, sharing saved colours across every picker.
import { ColorSwatch, extractBaseHex } from '@cujuju/solidjs-color-picker';
import { appearanceSettings, patchAppearanceSettings } from '@/state/preferences';
import styles from './AppearanceSection.module.css';
import { COLOR_PICKER_TOKENS, controlSwatchSize } from '@/theme/bridge/colorPicker';

/** Picks an opaque `#rrggbb`: opacity set in the picker is dropped, since theme colours are opaque. */
/** `flush`: borderless, filling a control's height, for a swatch joined to other controls in one bordered box. */
export function ColorField(props: { value: string; onChange: (hex: string) => void; label: string; flush?: boolean }) {
  return (
    <span class={styles.field}>
      <ColorSwatch
        value={props.value}
        onChange={(v) => {
          const hex = extractBaseHex(v).toLowerCase();
          // Cancel re-sends the colour the picker opened with; unchanged, it is no edit.
          if (hex !== props.value.toLowerCase()) props.onChange(hex);
        }}
        savedColors={appearanceSettings().savedColors}
        onSavedColorsChange={(savedColors) => patchAppearanceSettings({ savedColors })}
        label={props.label}
        tokens={COLOR_PICKER_TOKENS}
        alpha={false}
        size={props.flush ? controlSwatchSize() : undefined}
        noBorder={props.flush}
      />
    </span>
  );
}
