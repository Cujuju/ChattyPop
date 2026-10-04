import { describe, expect, it, vi } from 'vitest';
import { PROVIDER_DISPLAY_NAME_MAX } from '../src/shared/settings';
import { aiSettingsFrom as normalizeAiSettings, declaredProvider, providerDisplayName } from '../src/shared/aiProviders';

// The build includes the fixture provider plugins.
vi.mock('virtual:bundled-plugins/shared', async () => {
  const { alpha, beta } = await import('./p2Fixtures');
  return { default: [alpha, beta], catalog: null };
});

describe('provider display names', () => {
  it('fall back to the default when unset, blank or not a string', () => {
    expect(declaredProvider('p2alpha')?.displayName).toBe('Alpha');
    for (const displayName of [undefined, null, '', '   ', 42]) {
      const ai = normalizeAiSettings({ providers: { p2alpha: { enabled: true, displayName } } });
      expect(ai.providers['p2alpha']?.displayName).toBeNull();
      expect(providerDisplayName(ai, 'p2alpha')).toBe('Alpha');
    }
  });

  it("keep the owner's name, trimmed and capped", () => {
    const ai = normalizeAiSettings({
      providers: { p2alpha: { enabled: true, displayName: '  Opus  ' }, p2beta: { enabled: true, displayName: 'x'.repeat(PROVIDER_DISPLAY_NAME_MAX + 5) } },
    });
    expect(providerDisplayName(ai, 'p2alpha')).toBe('Opus');
    expect(providerDisplayName(ai, 'p2beta')).toHaveLength(PROVIDER_DISPLAY_NAME_MAX);
  });
});

describe('provider display names without the provider', () => {
  it("keep a provider's stored settings and name its id when this build doesn't declare it", () => {
    const ai = normalizeAiSettings({ providers: { gone: { enabled: true, displayName: 'Old' } } });
    expect(ai.providers['gone']).toEqual({ enabled: true, model: null, effort: null, displayName: 'Old' });
    expect(providerDisplayName(normalizeAiSettings({ providers: { gone: { enabled: true } } }), 'gone')).toBe('gone');
  });
});

describe('provider display name storage', () => {
  it("reads a name saved under the field's first key, shortName", () => {
    const ai = normalizeAiSettings({ providers: { p2alpha: { enabled: true, shortName: 'Opus' } } });
    expect(ai.providers['p2alpha']?.displayName).toBe('Opus');
  });
});
