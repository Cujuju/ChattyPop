// Chromium's spelling suggestions go only to the window whose editable word was right-clicked.
import { APP_EVENT_CHANNEL } from '@shared/contract';

export function forwardSpellingSuggestions(contents: Electron.WebContents): void {
  contents.on('context-menu', (_e, params) => {
    if (params.isEditable && params.misspelledWord) {
      contents.send(APP_EVENT_CHANNEL, {
        type: 'spelling-suggestions',
        word: params.misspelledWord,
        suggestions: params.dictionarySuggestions,
      });
    }
  });
}
