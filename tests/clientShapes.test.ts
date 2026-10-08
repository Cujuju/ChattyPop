// The client's own request and gateway shapes are learned (names only) and ours checked against them; ChattyPop's own traffic never teaches.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

vi.mock('electron', () => ({ app: { getPath: () => '' } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { ClientShapes, carried, gatewayRoute, routeTemplate } = await import('../src/main/discord/clientShapes');
const { HeaderCapture } = await import('../src/main/discord/capture');
const { GatewayTap } = await import('../src/main/discord/gatewayTap');

const C = '1000000000000000001';
const M = '1000000000000000002';
const api = (path: string): URL => new URL(path, 'https://discord.com/api/v9/');

describe('client shapes', () => {
  it('generalizes ids and reaction emoji, and reads names from query and body, never values', () => {
    expect(routeTemplate('PUT', api(`channels/${C}/messages/${M}/reactions/%F0%9F%91%8D/@me`))).toBe('PUT /api/v9/channels/:id/messages/:id/reactions/:emoji/@me');
    expect(carried(api(`channels/${C}/messages?limit=50&before=${M}`), null)).toEqual({ kind: 'none', fields: ['?limit', '?before'] });
    expect(carried(null, JSON.stringify({ content: 'secret', nonce: '1' }))).toEqual({ kind: 'json', fields: ['content', 'nonce'] });
    expect(carried(null, '------boundary\r\nContent-Disposition: form-data; name="payload_json"')).toEqual({ kind: 'multipart', fields: [] });
  });

  it("reports, once a run, fields the client never sent, fields it always sends that ours lack, and another encoding; it keeps what it learned", () => {
    const file = join(tempDir(), 'shapes.json');
    const reports: unknown[] = [];
    const shapes = new ClientShapes(file, (route, d) => reports.push({ route, ...d }), (m) => {
      throw new Error(m);
    });
    const route = 'POST /api/v9/channels/:id/messages';
    shapes.observe(route, { kind: 'json', fields: ['content', 'nonce', 'tts', 'flags', 'mobile_network_type'] });
    shapes.observe(route, { kind: 'json', fields: ['content', 'nonce', 'tts', 'flags', 'mobile_network_type', 'message_reference'] });
    shapes.check(route, { kind: 'json', fields: ['content', 'nonce', 'tts', 'flags', 'mobile_network_type', 'message_reference'] });
    expect(reports).toEqual([]);
    shapes.check(route, { kind: 'json', fields: ['content', 'nonce', 'tts', 'flags', 'enforce_nonce'] });
    shapes.check(route, { kind: 'json', fields: ['content'] });
    expect(reports).toEqual([{ route, extra: ['enforce_nonce'], missing: ['mobile_network_type'], kind: 'json', clientKinds: ['json'] }]);
    shapes.observe('POST /api/v9/interactions', { kind: 'multipart', fields: [] });
    shapes.check('POST /api/v9/interactions', { kind: 'json', fields: ['type'] });
    expect(reports.at(-1)).toMatchObject({ kind: 'json', clientKinds: ['multipart'] });
    // A route the client hasn't been seen sending can't be judged.
    shapes.check('GET /api/v9/never', { kind: 'none', fields: [] });
    expect(reports).toHaveLength(2);
    shapes.flush();
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    expect(saved[route]).toEqual({ seen: 2, bodies: { json: 2 }, fields: { content: 2, nonce: 2, tts: 2, flags: 2, mobile_network_type: 2, message_reference: 1 } });
    expect(JSON.stringify(saved)).not.toContain('secret');
    const again = new ClientShapes(file, (r) => reports.push(r), () => undefined);
    again.check(route, { kind: 'json', fields: ['content'] });
    expect(reports).toHaveLength(3);
  });

  it("learns the client's API requests and gateway sends, not ChattyPop's", () => {
    let before: ((d: { method: string; url: string; uploadData?: { bytes?: Buffer }[] }, cb: () => void) => void) | undefined;
    const session = { webRequest: { onBeforeRequest: (_f: unknown, l: typeof before) => (before = l), onBeforeSendHeaders: () => undefined, onCompleted: () => undefined } };
    const capture = new HeaderCapture(session as never);
    const seen: string[] = [];
    capture.onClientRequest = (method, url, body) => seen.push(`${method} ${url} ${body}`);
    const url = `https://discord.com/api/v9/channels/${C}/messages`;
    before!({ method: 'POST', url, uploadData: [{ bytes: Buffer.from('{"content":"a"}') }] }, () => undefined);
    const release = capture.own('POST', url);
    before!({ method: 'POST', url, uploadData: [{ bytes: Buffer.from('{"content":"b"}') }] }, () => undefined);
    release();
    expect(seen).toEqual([`POST ${url} {"content":"a"}`]);

    let cdp: ((e: unknown, method: string, params: Record<string, unknown>) => void) | undefined;
    const wc = { debugger: { attach: () => undefined, on: (_n: string, l: typeof cdp) => (cdp = l), sendCommand: async () => undefined } };
    const tap = new GatewayTap(wc as never);
    const sent: unknown[] = [];
    tap.on('sent', (s) => sent.push(['client', s]));
    cdp!({}, 'Network.webSocketCreated', { requestId: 'r', url: 'wss://gateway.discord.gg/?encoding=json&v=9' });
    const search = JSON.stringify({ op: 8, d: { query: 'a' } });
    cdp!({}, 'Network.webSocketFrameSent', { requestId: 'r', response: { opcode: 1, payloadData: search } });
    cdp!({}, 'Network.webSocketFrameSent', { requestId: 'r', response: { opcode: 1, payloadData: JSON.stringify({ op: 1, d: 5 }) } });
    cdp!({}, 'Network.webSocketFrameSent', { requestId: 'r', response: { opcode: 1, payloadData: search } });
    expect(sent).toEqual([
      ['client', { op: 8, d: { query: 'a' } }],
      ['client', { op: 1, d: 5 }],
      ['client', { op: 8, d: { query: 'a' } }],
    ]);
    expect(gatewayRoute(8)).toBe('gateway op 8');
  });
});
