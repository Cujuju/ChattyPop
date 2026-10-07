// Replays session-wide X-* headers case-insensitively, excluding per-request X-Context-Properties. Leaves embedded-client requests unchanged; ChattyPop's own requests are not observations.
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { getPath: () => tmpdir() } }));

const { HeaderCapture } = await import('../src/main/discord/capture');

type Listener = (details: { method: string; url: string; webContentsId?: number; requestHeaders: Record<string, string> }, cb: (r: { requestHeaders: Record<string, string> }) => void) => void;

/** A Discord session whose request hook the test drives. */
function fakeSession(): { session: never; send: (headers: Record<string, string>, url?: string) => Record<string, string> } {
  let listener: Listener | undefined;
  const session = { webRequest: { onBeforeRequest: () => undefined, onBeforeSendHeaders: (_f: unknown, l: Listener) => (listener = l), onCompleted: () => undefined } };
  const send = (headers: Record<string, string>, url = 'https://discord.com/api/v9/users/@me'): Record<string, string> => {
    let passed: Record<string, string> = {};
    listener!({ method: 'GET', url, webContentsId: 1, requestHeaders: headers }, (r) => (passed = r.requestHeaders));
    return passed;
  };
  return { session: session as never, send };
}

describe('header capture', () => {
  it('keeps only the session-wide X-* headers, whatever their case, and leaves the client request as sent', () => {
    const { session, send } = fakeSession();
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
    const { session, send } = fakeSession();
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
