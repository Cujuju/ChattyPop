import { createEffect, createSignal, untrack } from 'solid-js';
import { containedRoot } from '@plugin-sdk/renderer/containment';
import { createSetting } from '@plugin-sdk/renderer/settings';
import { stringsOr } from '@shared/normalize';
import { SETTINGS_KEYS } from '@shared/settings';
import type { SpellingWord } from '@shared/spelling';
import type { SpellingRequest, SpellingResponse } from './spellingWorker';

const [words, setWords, { loaded }] = createSetting<string[]>(SETTINGS_KEYS.spellingWords, [], (v) => [...new Set(stringsOr([])(v))]);
/** Bumps when the dictionary loads or the owner's words change, including on another device. */
const [revision, setSpellingRevision] = createSignal(0);
export const spellingRevision: () => number = revision;
let worker: Worker | undefined;
let ready = false;
let nextId = 0;
const pending = new Map<number, { resolve: (response: SpellingResponse) => void; reject: (error: Error) => void }>();
const post = (request: SpellingRequest): void => worker!.postMessage(request);

containedRoot(() => createEffect(() => {
  const added = words();
  if (worker) post({ kind: 'words', words: added });
  setSpellingRevision((revision) => revision + 1);
}));

function start(): void {
  if (worker) return;
  worker = new Worker(new URL('./spellingWorker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }: MessageEvent<SpellingResponse>): void => {
    if (data.kind === 'ready') {
      ready = true;
      setSpellingRevision((revision) => revision + 1);
    } else {
      pending.get(data.id)?.resolve(data);
      pending.delete(data.id);
    }
  };
  worker.onerror = (event): void => {
    ready = false;
    for (const request of pending.values()) request.reject(new Error(event.message));
    pending.clear();
  };
  post({ kind: 'load', words: untrack(words) });
}

function request(make: (id: number) => SpellingRequest): Promise<SpellingResponse> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve, reject });
    post(make(id));
  });
}

/** Starts loading on first call; returns no misspellings until ready. */
export async function misspellings(text: string): Promise<SpellingWord[]> {
  start();
  if (!ready) return [];
  const response = await request((id) => ({ kind: 'misspellings', id, text }));
  return response.kind === 'misspellings' ? response.words : [];
}

/** Up to SUGGESTION_MAX replacements, best first; empty until loaded. */
export async function spellingSuggestions(word: string): Promise<string[]> {
  if (!ready) return [];
  const response = await request((id) => ({ kind: 'suggestions', id, word }));
  return response.kind === 'suggestions' ? response.suggestions : [];
}

/** Persists the owner's word; rejects if saving fails. */
export async function addToDictionary(word: string): Promise<void> {
  await loaded;
  await setWords([...untrack(words), word]);
}
