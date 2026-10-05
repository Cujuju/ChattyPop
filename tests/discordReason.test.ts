// Contract: a refused request's error names Discord's reason and, for an Invalid Form Body, each field it refused.
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { discordReason } = await import('../src/main/discord/api');

describe("Discord's reason", () => {
  it('lists each refused field by its path', () => {
    const body = {
      code: 50035,
      message: 'Invalid Form Body',
      errors: { attachments: { 0: { description: { _errors: [{ code: 'BASE_TYPE_REQUIRED', message: 'This field is required' }] } } } },
    };
    expect(discordReason(JSON.stringify(body))).toBe('Invalid Form Body (attachments.0.description: This field is required)');
  });

  it('is the message alone without field errors, and empty for a body that is not JSON', () => {
    expect(discordReason(JSON.stringify({ message: 'Missing Access', code: 50001 }))).toBe('Missing Access');
    expect(discordReason('<html>')).toBe('');
  });
});
