// Ollama: local models on this PC or the LAN, at the address the owner sets (docs/research.md §2).
import { defineChannels, definePlugin, definePreference } from '@plugin-sdk/shared';
import { DEFAULT_OLLAMA_SETTINGS, OLLAMA_DEFAULT_URL, normalizeOllamaSettings } from './settings';
import type { OllamaPull } from './types';

/** Plugin event: a download started, progressed, failed or ended; payload every download still listed. */
export const PULLS_EVENT = 'pulls' as const;
/** Plugin event: a model finished installing; payload its name. */
export const INSTALLED_EVENT = 'installed' as const;

/** Core's calls from Settings → AI. */
export interface OllamaCoreCalls {
  /** Downloads running, and those that failed. */
  pulls(): OllamaPull[];
  /** Starts downloading `model` from Ollama's library; progress arrives as PULLS_EVENT. */
  pull(model: string): void;
  /** Stops a download (Ollama keeps what it has, so pulling again resumes) or clears a failed one. */
  cancelPull(model: string): void;
}

export interface OllamaEvents {
  [PULLS_EVENT]: OllamaPull[];
  [INSTALLED_EVENT]: string;
}

export const plugin = definePlugin({
  manifest: {
    id: 'ollama',
    name: 'Ollama',
    version: '1.0.0',
    description: 'Local models through Ollama, for channels set to local AI only and anything else you point at it.',
  },
  providers: [{
    id: 'ollama',
    label: 'Ollama · local',
    displayName: 'Ollama',
    // Needs a running Ollama server with a model installed.
    enabledByDefault: false,
    local: true,
    // Vision models (Ollama's `vision` capability) read images sent with a prompt.
    images: true,
  }],
  channels: defineChannels<{ core: OllamaCoreCalls; events: OllamaEvents }>()({
    core: {
      pulls: { audiences: ['renderer'], writes: false },
      pull: ['renderer'],
      cancelPull: ['renderer'],
    },
    events: { [PULLS_EVENT]: ['renderer'], [INSTALLED_EVENT]: ['renderer'] },
  }),
  /** Where its server listens, and how long it keeps a model loaded. */
  preferences: { settings: definePreference({ default: DEFAULT_OLLAMA_SETTINGS, normalize: normalizeOllamaSettings }) },
  network: { ownerUrls: [{ setting: 'settings', field: 'ollamaUrl', fallback: OLLAMA_DEFAULT_URL }] },
  adopts: {
    // Settings → AI held the address before Ollama was a plugin; builds without it park it (parkOllamaSettings).
    settingFields: [
      { key: 'legacy.ollamaSettings', field: 'ollamaUrl', name: 'settings' },
      { key: 'ai', field: 'ollamaUrl', name: 'settings' },
    ],
  },
});
export default plugin;
