// Nitro display-name fonts, as Discord's client maps them: its font enum (display_name_styles.font_id) to the
// @font-face family its page declares. Read from Discord's web client; undocumented, so it may change. Fonts Discord
// retired (Bangers, BioRhyme, Compagnon, Ribes, Hexagon) and DEFAULT draw in the default face, as in the client.

/** `key`: the name's data-name-font hook (theme/nameFonts.css); `family`: Discord's @font-face family for the file. */
export interface NameFont {
  key: string;
  family: string;
}

export const NAME_FONTS: Readonly<Record<number, NameFont>> = {
  3: { key: 'cherry-bomb', family: 'Sakura' },
  4: { key: 'chicle', family: 'Jellybean' },
  6: { key: 'museo-moderno', family: 'Modern' },
  7: { key: 'neo-castel', family: 'Medieval' },
  8: { key: 'pixelify', family: '8Bit' },
  10: { key: 'sinistre', family: 'Vampyre' },
  12: { key: 'zilla-slab', family: 'Tempo' },
  13: { key: 'playpen-sans', family: 'Monkey Bars' },
  14: { key: 'orbitron', family: 'Mainframe' },
  15: { key: 'new-rocker', family: 'Headbang' },
  16: { key: 'kalam', family: 'Journal' },
};

/**
 * Nitro display-name effects: Discord's effect enum (display_name_styles.effect_id) to the name's data-name-effect hook.
 * Read from Discord's web client (UNSPECIFIED 0 and its TEST_ values draw as none); undocumented, so it may change.
 */
export const NAME_EFFECTS = { 1: 'solid', 2: 'gradient', 3: 'neon', 4: 'toon', 5: 'pop', 6: 'glow', 7: 'prism', 8: 'gummy' } as const;
export type NameEffect = (typeof NAME_EFFECTS)[keyof typeof NAME_EFFECTS];

const FAMILIES = new Set(Object.values(NAME_FONTS).map((f) => f.family));
/** A family the name-font route may fetch; anything else is refused. */
export const isNameFontFamily = (family: string): boolean => FAMILIES.has(family);
