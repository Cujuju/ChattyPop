// Syntax highlighting for text attachments: Shiki, its JavaScript regex engine (the page's CSP allows no WASM), and a
// theme whose colors are --cp-code-* tokens, so each app theme colors code. Grammars load on first use.
import { createCssVariablesTheme, createHighlighterCore, type HighlighterCore, type ThemedToken } from 'shiki/core';
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript';
import { bundledLanguagesInfo } from 'shiki/langs';

/** No grammar: the text as written. */
export const PLAIN_LANGUAGE = 'text';

const THEME = createCssVariablesTheme({ name: 'chattypop', variablePrefix: '--cp-code-' });

/** Grammars by every name Shiki knows them by: id and aliases. */
const byName = new Map(bundledLanguagesInfo.flatMap((l) => [l.id, ...(l.aliases ?? [])].map((n) => [n, l] as const)));

/** The languages a reader can pick, by display name. */
export const LANGUAGES: readonly { id: string; name: string }[] = [
  { id: PLAIN_LANGUAGE, name: 'Plain text' },
  ...bundledLanguagesInfo.map((l) => ({ id: l.id, name: l.name })).sort((a, b) => a.name.localeCompare(b.name)),
];

/** The grammar a file ending names (Shiki id or alias), else plain text. */
export const languageFor = (extension: string): string => byName.get(extension)?.id ?? PLAIN_LANGUAGE;

let highlighter: Promise<HighlighterCore> | null = null;
const core = (): Promise<HighlighterCore> =>
  (highlighter ??= createHighlighterCore({ themes: [THEME], langs: [], engine: createJavaScriptRegexEngine() }));

/** A line's colored runs; a token's color is a var(--cp-code-…) reference. */
export type CodeLine = ThemedToken[];

/** The text split into lines of colored runs, its grammar loaded first. Plain text is one run per line. */
export async function highlightLines(text: string, language: string): Promise<CodeLine[]> {
  const info = byName.get(language);
  if (!info) return text.split('\n').map((content) => [{ content, offset: 0 }]);
  const h = await core();
  if (!h.getLoadedLanguages().includes(info.id)) await h.loadLanguage(info.import);
  return h.codeToTokensBase(text, { lang: info.id, theme: THEME.name });
}
