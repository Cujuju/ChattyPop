// Typed emoticons turned into emoji, as Discord's "Automatically convert emoticons" does, on the text being sent.

/**
 * Emoticons by the emoji they become. Assumption: Discord's shortcut list (not in the live client's bundle); the emoji
 * are its own for those names (verified 2026-10-06 in its emoji data: slight_smile 🙂, frowning 😦 …).
 */
const EMOTICONS: Readonly<Record<string, readonly string[]>> = {
  '🙂': [':)', ':-)', '=)', '=-)'],
  '😦': [':(', ':-(', '=(', '=-('],
  '😄': [':D', ':-D', '=D', '=-D'],
  '😛': [':P', ':-P', ':p', ':-p', '=P', '=-P'],
  '😉': [';)', ';-)'],
  '😮': [':o', ':-o', ':O', ':-O'],
  '😐': [':|', ':-|'],
  '😕': [':-/', ':-\\'],
  '😢': [":'("],
  '😂': [":')"],
  '😠': ['>:(', '>:-('],
  '😇': ['O:)', 'O:-)', '0:)'],
  '😗': [':*', ':-*'],
  '😎': ['8-)', 'B-)'],
  '❤️': ['<3'],
  '💔': ['</3'],
};

const BY_EMOTICON = new Map(Object.entries(EMOTICONS).flatMap(([emoji, faces]) => faces.map((face) => [face, emoji] as const)));
const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** An emoticon standing alone: after the start or whitespace, before whitespace or the end. Longest first, so >:( beats :(. */
const EMOTICON = new RegExp(
  `(^|\\s)(${[...BY_EMOTICON.keys()].sort((a, b) => b.length - a.length).map(escape).join('|')})(?=\\s|$)`,
  'g',
);
/** Code blocks and inline code: text inside them is left as typed. */
const CODE = /```[\s\S]*?```|`[^`\n]*`/g;

/** `text` with each standalone emoticon outside code turned into its emoji. */
export function convertEmoticons(text: string): string {
  let out = '';
  let at = 0;
  for (const m of text.matchAll(CODE)) {
    out += replaceIn(text.slice(at, m.index)) + m[0];
    at = m.index + m[0].length;
  }
  return out + replaceIn(text.slice(at));
}

const replaceIn = (s: string): string => s.replace(EMOTICON, (_m, before: string, face: string) => before + BY_EMOTICON.get(face)!);
