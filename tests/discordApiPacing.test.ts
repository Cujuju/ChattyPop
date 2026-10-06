// Discord requests serialize. Prompt requests precede waiting paced requests; paced requests preserve order. Automatic posts wait once using the configured pause and jitter.
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { DiscordApi } = await import('../src/main/discord/api');
const { Pace } = await import('../src/main/sync/pace');
const { normalizeArchiveSettings, automaticPostPauseRange, AUTOMATIC_POST_PAUSE_MIN_S, AUTOMATIC_POST_PAUSE_MAX_S } = await import('../src/shared/archiveSettings');

/** A pace far longer than the test could wait by accident. */
const PACE_MS = 60_000;

let sent: string[];
let api: InstanceType<typeof DiscordApi>;
beforeEach(() => {
  vi.useFakeTimers();
  sent = [];
  const page = {
    isDestroyed: () => false,
    // The page's fetch: records the URL the script asks for and answers 200 with an empty JSON object.
    executeJavaScript: async (script: string) => {
      sent.push(/fetch\("https:\/\/discord\.com\/api\/v9\/([^"?]+)/.exec(script)![1]!);
      return { status: 200, headers: {}, body: '{}' };
    },
  };
  const capture = { current: { authorization: 'token', extra: {} }, invalidate: () => undefined };
  api = new DiscordApi(() => page as never, capture as never, async () => ({ apiMs: PACE_MS, mediaMs: 0, jitter: 0 }));
});
afterEach(() => vi.useRealTimers());

describe('Discord request pacing', () => {
  it('sends prompt requests ahead of a paced one not yet sent, in order, and paces the rest', async () => {
    const sync = api.get('channels/1/messages');
    const profile = api.prompt.get('users/2/profile');
    const note = api.prompt.get('users/@me/notes/2');
    const after = api.get('channels/3/messages');

    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([profile, note]);
    // Asked before the sync request went out, both reads go ahead of it, without the pace.
    expect(sent).toEqual(['users/2/profile', 'users/@me/notes/2']);

    // Each paced request waits a full pace after the request before it, in the order asked.
    await vi.advanceTimersByTimeAsync(PACE_MS - 1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await sync;
    await vi.advanceTimersByTimeAsync(PACE_MS);
    await after;
    expect(sent.slice(2)).toEqual(['channels/1/messages', 'channels/3/messages']);
  });

  it('sends a read about people ahead of paced requests still waiting for their pace, then paces the rest in order', async () => {
    const first = api.get('channels/1/messages');
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const second = api.get('channels/2/messages');
    const third = api.get('channels/3/messages');
    await vi.advanceTimersByTimeAsync(PACE_MS / 2);

    // Asked mid-pace: it goes out now, ahead of both waiting requests.
    const profile = api.prompt.get('users/4/profile');
    await vi.advanceTimersByTimeAsync(0);
    await profile;
    expect(sent).toEqual(['channels/1/messages', 'users/4/profile']);

    // The waiting requests keep their order, each a full pace after the request before it.
    await vi.advanceTimersByTimeAsync(PACE_MS - 1);
    expect(sent).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    await vi.advanceTimersByTimeAsync(PACE_MS);
    await third;
    expect(sent.slice(2)).toEqual(['channels/2/messages', 'channels/3/messages']);
  });

  it('never has two requests in flight', async () => {
    let inFlight = 0;
    let most = 0;
    const page = {
      isDestroyed: () => false,
      executeJavaScript: async () => {
        most = Math.max(most, ++inFlight);
        await new Promise((r) => setTimeout(r, 10));
        inFlight--;
        return { status: 200, headers: {}, body: '{}' };
      },
    };
    const capture = { current: { authorization: 'token', extra: {} }, invalidate: () => undefined };
    const slow = new DiscordApi(() => page as never, capture as never, async () => ({ apiMs: 0, mediaMs: 0, jitter: 0 }));
    const all = Promise.all([slow.get('a'), slow.prompt.get('b'), slow.prompt.get('c'), slow.get('d')]);
    await vi.advanceTimersByTimeAsync(10_000);
    await all;
    expect(most).toBe(1);
  });
});

describe('owner writes', () => {
  it('sends a write on the prompt lane ahead of a paced request waiting for its pace', async () => {
    const first = api.get('channels/1/messages');
    await vi.advanceTimersByTimeAsync(0);
    await first;
    const waiting = api.get('channels/2/messages');
    const message = api.prompt.post('channels/9/messages', { content: 'hi' });
    await vi.advanceTimersByTimeAsync(0);
    await message;
    expect(sent).toEqual(['channels/1/messages', 'channels/9/messages']);
    await vi.advanceTimersByTimeAsync(PACE_MS);
    await waiting;
  });
});

describe('automatic post pause', () => {
  const SETTING_S = 3;
  const paceWith = (automaticPostPauseS: unknown) => new Pace({ call: async () => ({ automaticPostPauseS }) } as never);
  /** How long humanPause waits with Math.random() returning `r`. */
  const pauseWith = async (r: number): Promise<number> => {
    vi.spyOn(Math, 'random').mockReturnValue(r);
    const pace = paceWith(SETTING_S);
    let done = false;
    const start = Date.now();
    void pace.humanPause().then(() => (done = true));
    while (!done) await vi.advanceTimersByTimeAsync(1);
    vi.restoreAllMocks();
    return Date.now() - start;
  };

  it('waits the setting ± its jitter, the range Settings shows', async () => {
    const range = automaticPostPauseRange(SETTING_S);
    expect(range.min).toBeCloseTo(1.95);
    expect(range.max).toBeCloseTo(4.05);
    expect(await pauseWith(0)).toBeCloseTo(range.min * 1000, -1);
    expect(await pauseWith(1)).toBeCloseTo(range.max * 1000, -1);
  });

  it('keeps the setting within its bounds, so a post never goes out within milliseconds', () => {
    expect(normalizeArchiveSettings({ automaticPostPauseS: 0 }).automaticPostPauseS).toBe(AUTOMATIC_POST_PAUSE_MIN_S);
    expect(normalizeArchiveSettings({ automaticPostPauseS: 3600 }).automaticPostPauseS).toBe(AUTOMATIC_POST_PAUSE_MAX_S);
    expect(normalizeArchiveSettings({ automaticPostPauseS: 2.5 }).automaticPostPauseS).toBe(2.5);
  });
});
