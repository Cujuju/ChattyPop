// Contract tests for provider effort.
import { describe, expect, it } from 'vitest';
import { normalizeAiSettings } from '@shared/settings';

describe('provider effort setting', () => {
  it('keeps a stored level; blank, missing or not a string is the provider default', () => {
    expect(normalizeAiSettings({ providers: { claude: { enabled: true, effort: 'high' } } }).providers['claude']?.effort).toBe('high');
    for (const effort of [undefined, null, '', '  ', 3]) {
      expect(normalizeAiSettings({ providers: { codex: { enabled: true, effort } } }).providers['codex']?.effort).toBeNull();
    }
  });
});
