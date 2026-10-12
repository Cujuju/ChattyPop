import { describe, expect, it } from 'vitest';
import type { SecretFiles } from '../src/main/plugins/context';
import { forgetProviderKey, loadProviderKeys, PROVIDER_KEYS_FILE, saveProviderKey } from '../src/main/providerKeys';

function store(): SecretFiles {
  const files = new Map<string, string>();
  return { read: (file) => files.get(file) ?? null, write: (file, value) => { files.set(file, value); }, delete: (file) => { files.delete(file); } };
}

describe('encrypted provider key object', () => {
  it('saves, replaces and forgets one provider without changing another', () => {
    const secrets = store();
    expect(loadProviderKeys(secrets)).toEqual({});
    expect(saveProviderKey(secrets, 'first', 'test-key')).toEqual({ first: 'test-key' });
    saveProviderKey(secrets, 'second', 'test-other');
    expect(saveProviderKey(secrets, 'first', 'test-replacement')).toEqual({ first: 'test-replacement', second: 'test-other' });
    expect(loadProviderKeys(secrets)).toEqual({ first: 'test-replacement', second: 'test-other' });
    expect(forgetProviderKey(secrets, 'first')).toEqual({ second: 'test-other' });
    expect(forgetProviderKey(secrets, 'missing')).toEqual({ second: 'test-other' });
    expect(forgetProviderKey(secrets, 'second')).toEqual({});
  });
  it.each(['bad-json', 'null', '[]', 'true', '{"first":1}', '{"first":""}'])('unusable encrypted contents %s return empty', (value) => {
    const secrets = store();
    secrets.write(PROVIDER_KEYS_FILE, value);
    expect(loadProviderKeys(secrets)).toEqual({});
  });
  it('unreadable storage returns empty', () => {
    const secrets = store();
    secrets.read = () => { throw new Error('cannot decrypt'); };
    expect(loadProviderKeys(secrets)).toEqual({});
  });
});
