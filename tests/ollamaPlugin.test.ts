// Ollama's address on upgrade: parked out of the AI settings, it survives saves while no plugin claims it, and moves
// into the adopting plugin's setting intact.
import { describe, expect, it } from 'vitest';
import { definePlugin, definePreference, isObj } from '@plugin-sdk/shared';
import { normalizeAiSettings } from '@shared/settings';
import { getSetting, setSetting } from '../src/core/db';
import { parkOllamaSettings } from '../src/core/laterMigrations';
import { adoptBundledData } from '../src/core/plugins/adoption';
import { tempDb } from './helpers';

const LAN_ADDRESS = 'http://10.0.0.5:11434';
/** Settings → AI as saved before Ollama was a plugin. */
const PRE_EXTRACTION = { defaultProvider: 'ollama', ollamaUrl: LAN_ADDRESS, providers: { ollama: { enabled: true, model: 'llama3', effort: 'on', displayName: null } } };
/** Adopts the parked address (and one still in the AI settings) into its `settings`, as the Ollama plugin declares. */
const ollama = definePlugin({
  manifest: { id: 'ollama', name: 'Ollama', version: '1', description: '' },
  preferences: { settings: definePreference<{ ollamaUrl?: unknown }>({ default: {}, normalize: (v) => (isObj(v) ? v : {}) }) },
  adopts: {
    settingFields: [
      { key: 'legacy.ollamaSettings', field: 'ollamaUrl', name: 'settings' },
      { key: 'ai', field: 'ollamaUrl', name: 'settings' },
    ],
  },
});

describe('Ollama address on upgrade', () => {
  it('parks the address out of the AI settings, survives an absent-plugin save, and is adopted once', () => {
    const db = tempDb();
    setSetting(db, 'ai', PRE_EXTRACTION);
    parkOllamaSettings(db);
    // A build without Ollama saves Settings → AI: the address is not part of it any more.
    setSetting(db, 'ai', normalizeAiSettings(getSetting(db, 'ai')));
    parkOllamaSettings(db);
    expect(getSetting(db, 'legacy.ollamaSettings')).toEqual({ ollamaUrl: LAN_ADDRESS });
    expect(getSetting(db, 'ai')).not.toHaveProperty('ollamaUrl');
    adoptBundledData(db, [ollama]);
    adoptBundledData(db, [ollama]);
    expect(getSetting(db, 'plugin.ollama.settings')).toEqual({ ollamaUrl: LAN_ADDRESS });
    expect(normalizeAiSettings(getSetting(db, 'ai')).providers['ollama']).toEqual(PRE_EXTRACTION.providers.ollama);
  });
});
