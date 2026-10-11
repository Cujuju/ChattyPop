// How a run starts (main/launchMode.ts) and a server's pairing codes (main/serverMode.ts).
import { describe, expect, it, vi } from 'vitest';
import { LAUNCH_MODE_ENV, launchMode, serverOrigin } from '../src/main/launchMode';
import { NO_TRANSPORT_TEXT, pairingText, showPairing } from '../src/main/serverMode';

describe('launch mode', () => {
  it('starts the app unless a flag or the environment says otherwise', () => {
    expect(launchMode(['electron', '.'], {})).toEqual({ kind: 'app' });
    expect(launchMode(['electron', '.', '--server'], {})).toEqual({ kind: 'server', printPairing: false });
    expect(launchMode(['electron', '.', '--server', '--pair'], {})).toEqual({ kind: 'server', printPairing: true });
    expect(launchMode(['electron', '.'], { [LAUNCH_MODE_ENV]: 'Server' })).toEqual({ kind: 'server', printPairing: false });
    expect(launchMode(['electron', '.'], { [LAUNCH_MODE_ENV]: 'client' })).toEqual({ kind: 'client', origin: null });
  });

  it('connects to the server a flag names, and shows the saved servers for a bare or malformed one', () => {
    expect(launchMode(['x', '--connect=https://pc.tail1.ts.net:8443/desktop'], {})).toEqual({ kind: 'client', origin: 'https://pc.tail1.ts.net:8443' });
    expect(launchMode(['x', '--connect=pc.tail1.ts.net:8443'], {})).toEqual({ kind: 'client', origin: 'https://pc.tail1.ts.net:8443' });
    expect(launchMode(['x', '--connect'], {})).toEqual({ kind: 'client', origin: null });
    expect(launchMode(['x', '--connect=http://pc:8443'], {})).toEqual({ kind: 'client', origin: null });
    // A flag wins over the environment.
    expect(launchMode(['x', '--connect'], { [LAUNCH_MODE_ENV]: 'server' })).toEqual({ kind: 'client', origin: null });
  });

  it('takes only https servers', () => {
    expect(serverOrigin('  pc.tail1.ts.net  ')).toBe('https://pc.tail1.ts.net');
    expect(serverOrigin('http://pc.tail1.ts.net')).toBeNull();
    expect(serverOrigin('file:///etc/passwd')).toBeNull();
    expect(serverOrigin('')).toBeNull();
    expect(serverOrigin('https://')).toBeNull();
  });
});

describe('server pairing', () => {
  const prompt = { code: '123456', url: 'https://pc.tail1.ts.net:8443/pair?code=123456', expiresAt: Date.now() + 60_000 };

  it("says where a computer and a phone type the code", () => {
    const text = pairingText(prompt);
    expect(text).toContain('Pairing code: 123456');
    expect(text).toContain('https://pc.tail1.ts.net:8443/desktop');
    expect(text).toContain(prompt.url);
    expect(pairingText({ ...prompt, url: null })).toContain('isn’t published yet');
  });

  it('asks once from the tray, and says why there is no code', async () => {
    const shown: string[] = [];
    const start = vi.fn(async () => null);
    await showPairing(start, (t) => void shown.push(t));
    expect(start).toHaveBeenCalledOnce();
    expect(shown).toEqual([NO_TRANSPORT_TEXT]);
  });

  it('keeps asking from a terminal while the transport starts, then prints the code', async () => {
    const printed: string[] = [];
    let calls = 0;
    const start = async () => (++calls < 3 ? null : prompt);
    const wait = vi.fn(async () => undefined);
    await showPairing(start, (t) => void printed.push(t), 60_000, wait);
    expect(calls).toBe(3);
    expect(wait).toHaveBeenCalledTimes(2);
    expect(printed[0]).toContain('123456');
  });
});
