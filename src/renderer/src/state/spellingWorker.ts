import nspell from 'nspell';
// Explicit paths bypass dictionary-en's Node-only export. Vite embeds these in the worker in dev and builds.
import aff from '@spelling-dictionary/index.aff?raw';
import dic from '@spelling-dictionary/index.dic?raw';
import { rankSuggestions, spellingWords, type SpellingWord } from '@shared/spelling';

export type SpellingRequest =
  | { kind: 'load' | 'words'; words: string[] }
  | { kind: 'misspellings'; id: number; text: string }
  | { kind: 'suggestions'; id: number; word: string };
export type SpellingResponse =
  | { kind: 'ready' }
  | { kind: 'misspellings'; id: number; words: SpellingWord[] }
  | { kind: 'suggestions'; id: number; suggestions: string[] };

let checker: ReturnType<typeof nspell>;
const reply = (response: SpellingResponse): void => self.postMessage(response);
self.onmessage = ({ data }: MessageEvent<SpellingRequest>): void => {
  switch (data.kind) {
    case 'load':
      checker = nspell({ aff, dic });
      for (const word of data.words) checker.add(word.replaceAll('’', "'"));
      reply({ kind: 'ready' });
      break;
    case 'words':
      for (const word of data.words) checker.add(word.replaceAll('’', "'"));
      break;
    case 'misspellings':
      reply({ kind: 'misspellings', id: data.id, words: spellingWords(data.text).filter(({ word }) => !checker.correct(word.replaceAll('’', "'"))) });
      break;
    case 'suggestions':
      reply({ kind: 'suggestions', id: data.id, suggestions: rankSuggestions(data.word, checker.suggest(data.word.replaceAll('’', "'"))) });
      break;
  }
};
