// Replays session-wide X-* headers case-insensitively, excluding per-request X-Context-Properties. Leaves embedded-client requests unchanged; ChattyPop's own requests are not observations.
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { fakeDiscordSession } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { HeaderCapture } = await import('../src/main/discord/capture');

describe('header capture', () => {
  it('keeps only the session-wide X-* headers, whatever their case, and leaves the client request as sent', () => {
    const { session, send } = fakeDiscordSession();
    const capture = new HeaderCapture(session);
    const sent = {
      Authorization: 'token',
      'x-super-properties': 'props',
      'X-Discord-Locale': 'en-US',
      'X-DISCORD-TIMEZONE': 'Europe/London',
      'X-Debug-Options': 'bugReporterEnabled',
      'X-Context-Properties': 'context',
      'X-Failed-Requests': '1',
      'X-Audit-Log-Reason': 'reason',
      'X-Fingerprint': 'fp',
      'X-Installation-ID': 'install',
      'Content-Type': 'application/json',
    };
    expect(send(sent)).toEqual(sent);
    expect(capture.current?.authorization).toBe('token');
    expect(capture.current?.extra).toEqual({
      'x-super-properties': 'props',
      'X-Discord-Locale': 'en-US',
      'X-DISCORD-TIMEZONE': 'Europe/London',
      'X-Debug-Options': 'bugReporterEnabled',
      'X-Fingerprint': 'fp',
      'X-Installation-ID': 'install',
    });
  });

  it("ignores ChattyPop's own requests: their headers and page sizes are replays, not the client's", () => {
    const { session, send } = fakeDiscordSession();
    const capture = new HeaderCapture(session);
    send({ Authorization: 'client', 'X-Super-Properties': 'new' });
    const url = 'https://discord.com/api/v9/channels/1/messages?limit=50';
    const release = capture.own('GET', url);
    send({ Authorization: 'client', 'X-Super-Properties': 'old' }, url);
    release();
    expect(capture.current?.extra).toEqual({ 'X-Super-Properties': 'new' });
    expect(capture.observedLimits).toEqual([]);
    // Answered, the same request from the client counts again.
    send({ Authorization: 'client', 'X-Super-Properties': 'newer' }, url);
    expect(capture.current?.extra).toEqual({ 'X-Super-Properties': 'newer' });
    expect(capture.observedLimits).toEqual([50]);
  });
});
