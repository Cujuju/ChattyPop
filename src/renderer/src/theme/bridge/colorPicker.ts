// @cujuju/solidjs-color-picker: its look tokens (inline styles, never canvas) as the theme's colours, so the picker
// follows every theme. Spacing and radii keep the package's defaults.
import type { PickerTokens } from '@cujuju/solidjs-color-picker';

export const COLOR_PICKER_TOKENS: Partial<PickerTokens> = {
  bg: 'var(--cp-surface-1)',
  bgInput: 'var(--cp-surface-0)',
  border: 'var(--cp-border)',
  borderHover: 'var(--cp-border-strong)',
  text: 'var(--cp-text-1)',
  textMuted: 'var(--cp-text-2)',
  textDim: 'var(--cp-text-muted)',
  accent: 'var(--cp-accent)',
  textOnAccent: 'var(--cp-text-on-accent)',
};

const tokenPx = (token: string): number => parseFloat(getComputedStyle(document.documentElement).getPropertyValue(token)) || 0;

/** Swatch edge (px; the package takes a number) filling a settings button's height inside its border, so a swatch sits flush in a control row. */
export const controlSwatchSize = (): number => tokenPx('--cp-btn-h-sm') - 2 * tokenPx('--cp-border-w');
