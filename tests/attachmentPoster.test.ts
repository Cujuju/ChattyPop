// A video attachment's poster (cp-media://poster/<id>): Discord's media proxy still for its signed CDN URL, cached by
// attachment id, refreshed once when the URL expired; core names where it comes from until the attachment leaves Discord.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron';
import { beforeEach, describe, expect, it } from 'vitest';
import { ARRIVAL } from '../src/core/arrival';
import { attachmentSource } from '../src/core/mediaQueue';
import { attachmentPoster, type MediaSessions, type PosterSource } from '../src/main/media/thumbStore';
import { rawMessage, seedArchive, tempDb } from './helpers';

const ID = '300000000000000001';
const signed = (sig: string) => `https://cdn.discordapp.com/attachments/1/${ID}/clip.mov?ex=1&is=2&hm=${sig}&`;
const STILL = 'still bytes';
const HTTP_OK = 200;
const HTTP_NOT_FOUND = 404;
const HTTP_GATEWAY_TIMEOUT = 504;

/** Sessions whose Discord one answers each fetch with the status `answer` picks, recording what was asked. */
function sessions(answer: (url: URL) => number): { s: MediaSessions; asked: URL[] } {
  const asked: URL[] = [];
  const fetch = async (raw: string) => {
    const url = new URL(raw);
    asked.push(url);
    const status = answer(url);
    return new Response(status === HTTP_OK ? new TextEncoder().encode(STILL) : null, { status, headers: { 'content-type': 'image/webp' } });
  };
  return { s: { discord: { fetch } as unknown as Session, web: {} as Session }, asked };
}

const source = (stored: string, fresh: string | undefined = undefined): PosterSource & { refreshed: number } => {
  const src = { stored, refreshed: 0, fresh: async () => (src.refreshed++, fresh) };
  return src;
};
const dir = () => mkdtempSync(join(tmpdir(), 'cp-poster-'));
const text = (m: { bytes: Buffer } | null) => m && m.bytes.toString();

describe('attachmentPoster', () => {
  it('asks the media proxy for a still of the signed path, then serves it from the cache under any later signature', async () => {
    const { s, asked } = sessions(() => HTTP_OK);
    const d = dir();
    expect(text(await attachmentPoster(s, d, ID, source(signed('a'))))).toBe(STILL);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.hostname).toBe('media.discordapp.net');
    expect(asked[0]!.pathname).toBe(`/attachments/1/${ID}/clip.mov`);
    expect(asked[0]!.searchParams.get('hm')).toBe('a');
    expect(asked[0]!.searchParams.get('format')).toBe('webp');
    expect(text(await attachmentPoster(s, d, ID, source(signed('b'))))).toBe(STILL);
    expect(asked).toHaveLength(1);
  });

  it('reads a fresh URL once when the stored one expired', async () => {
    const { s } = sessions((url) => (url.searchParams.get('hm') === 'old' ? HTTP_NOT_FOUND : HTTP_OK));
    const src = source(signed('old'), signed('new'));
    expect(text(await attachmentPoster(s, dir(), ID, src))).toBe(STILL);
    expect(src.refreshed).toBe(1);
  });

  it('gives none, without a refresh or a cached failure, when the proxy fails otherwise', async () => {
    let status = HTTP_GATEWAY_TIMEOUT;
    const { s } = sessions(() => status);
    const d = dir();
    const src = source(signed('a'), signed('b'));
    expect(await attachmentPoster(s, d, ID, src)).toBeNull();
    expect(src.refreshed).toBe(0);
    status = HTTP_OK;
    expect(text(await attachmentPoster(s, d, ID, src))).toBe(STILL);
  });

  it('fetches nothing for a URL off Discord’s attachment CDN', async () => {
    const { s, asked } = sessions(() => HTTP_OK);
    expect(await attachmentPoster(s, dir(), ID, source('https://example.com/clip.mov'))).toBeNull();
    expect(asked).toHaveLength(0);
  });
});

describe('attachmentSource', () => {
  const GENERAL = '200000000000000001';
  const T0 = Date.UTC(2026, 8, 1);
  let archive: ReturnType<typeof seedArchive>;
  let db: ReturnType<typeof tempDb>;
  beforeEach(() => {
    db = tempDb();
    archive = seedArchive(db, [{ id: GENERAL }]);
  });
  const file = (id: string) => ({ id, filename: `${id}.mov`, url: signed(id) });

  it('names an archived attachment’s message, channel and URL; none once it or its message left Discord', () => {
    const m = { ...rawMessage(GENERAL, T0, 'clips'), attachments: [file('a1'), file('a2')] };
    archive.ingestMessages([m], ARRIVAL.gateway);
    expect(attachmentSource(db, 'a1')).toEqual({ id: 'a1', messageId: m.id, channelId: GENERAL, url: signed('a1'), filename: 'a1.mov' });
    archive.applyUpdate({ id: m.id, channel_id: GENERAL, attachments: [file('a2')] });
    expect(attachmentSource(db, 'a1')).toBeNull();
    archive.markDeleted(GENERAL, m.id, T0 + 1);
    expect(attachmentSource(db, 'a2')).toBeNull();
    expect(attachmentSource(db, 'missing')).toBeNull();
  });
});
