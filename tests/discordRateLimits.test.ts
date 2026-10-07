// Discord's stated waits outlive the request that got them: per route, or for every route. Paths stay under /api/v9/.
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discordPage } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { DiscordApi } = await import('../src/main/discord/api');
const { RateLimits, routeKey } = await import('../src/main/discord/rateLimits');

const CHANNEL = '1000000000000000001';
const MESSAGE = '1000000000000000002';
const USER = '1000000000000000003';
const RETRY_S = 30;
const api = (path: string): URL => new URL(path, 'https://discord.com/api/v9/');

describe('rate-limit routes', () => {
  it("keeps the first major parameter's id and generalizes the rest", () => {
    expect(routeKey('DELETE', api(`channels/${CHANNEL}/messages/${MESSAGE}`))).toBe(`DELETE /api/v9/channels/${CHANNEL}/messages/:id`);
    expect(routeKey('GET', api(`users/${USER}/profile`))).toBe('GET /api/v9/users/:id/profile');
  });

  it('records a 429 wait from the header or the body, whichever is longer, and globally when Discord says so', () => {
    let now = 0;
    const limits = new RateLimits(() => now);
    limits.note('a', { status: 429, headers: { 'retry-after': '2' }, body: JSON.stringify({ retry_after: 3.5 }) });
    expect(limits.until('a')).toBe(3500);
    expect(limits.until('b')).toBe(0);
    limits.note('a', { status: 429, headers: { 'x-ratelimit-global': 'true', 'retry-after': '10' }, body: '' });
    expect(limits.until('b')).toBe(10_000);
    now = 20_000;
    limits.note('c', { status: 200, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset-after': '120' }, body: '' });
    expect(limits.until('c')).toBe(140_000);
    // A 429 without a stated wait records nothing: the caller backs off.
    limits.note('d', { status: 429, headers: {}, body: 'not json' });
    expect(limits.until('d')).toBe(10_000);
  });
});

describe('Discord API rate limits and paths', () => {
  let sent: string[];
  let answer: (path: string) => { status: number; headers: Record<string, string>; body: string };
  let client: InstanceType<typeof DiscordApi>;
  beforeEach(() => {
    vi.useFakeTimers();
    sent = [];
    answer = () => ({ status: 200, headers: {}, body: '{}' });
    const page = discordPage(async (script: string) => {
      const path = /fetch\("https:\/\/discord\.com\/api\/v9\/([^"?]+)/.exec(script)![1]!;
      sent.push(path);
      return answer(path);
    });
    const capture = { current: { authorization: 'token', extra: {} }, invalidate: () => undefined, own: () => () => undefined };
    client = new DiscordApi(() => page as never, capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
  });
  afterEach(() => vi.useRealTimers());

  it("keeps a final 429's wait for the next request on its route, not for other routes", async () => {
    answer = () => ({ status: 429, headers: { 'retry-after': String(RETRY_S) }, body: '{}' });
    const limited = client.prompt.post(`channels/${CHANNEL}/messages`, {}).catch((e: unknown) => e);
    // Five attempts, each after the wait the one before was told: the last is answered at 4 waits.
    await vi.advanceTimersByTimeAsync(4 * RETRY_S * 1000);
    expect(await limited).toBeInstanceOf(Error);
    answer = () => ({ status: 200, headers: {}, body: '{}' });
    const before = sent.length;
    const other = client.prompt.get(`users/${USER}/profile`);
    await vi.advanceTimersByTimeAsync(0);
    await other;
    expect(sent.length).toBe(before + 1);
    const again = client.prompt.post(`channels/${CHANNEL}/messages`, {});
    await vi.advanceTimersByTimeAsync(RETRY_S * 1000 - 1);
    expect(sent.length).toBe(before + 1);
    await vi.advanceTimersByTimeAsync(1);
    await again;
    expect(sent.length).toBe(before + 2);
  });

  it('refuses a path outside /api/v9/ before sending anything', async () => {
    for (const path of ['https://example.com/x', '/api/v10/users/@me', '../v10/users/@me', '//example.com/x']) {
      await expect(client.get(path)).rejects.toThrow('Not a Discord API path');
      await expect(client.prompt.post(path, {})).rejects.toThrow('Not a Discord API path');
    }
    expect(sent).toEqual([]);
  });
});
