// Maps undocumented Discord font ids to page families. Retired/default fonts use fallback faces; mappings can change with client deployments.

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

/** Maps undocumented Discord effect ids to data-name-effect hooks. Unspecified/test effects use none; client mappings can change. */
export const NAME_EFFECTS = { 1: 'solid', 2: 'gradient', 3: 'neon', 4: 'toon', 5: 'pop', 6: 'glow', 7: 'prism', 8: 'gummy' } as const;
export type NameEffect = (typeof NAME_EFFECTS)[keyof typeof NAME_EFFECTS];

const FAMILIES = new Set(Object.values(NAME_FONTS).map((f) => f.family));
/** A family the name-font route may fetch; anything else is refused. */
export const isNameFontFamily = (family: string): boolean => FAMILIES.has(family);
