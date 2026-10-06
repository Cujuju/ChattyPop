// A video attachment's poster (cp-media://poster/<id>): Discord's media proxy still for its signed CDN URL, kept by
// attachment id so it outlives the attachment on Discord, refreshed once when the URL expired. The downloader keeps it
// as the video is archived; core names where it comes from until the attachment leaves Discord.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { PendingAttachment } from '@shared/contract';
import type { CoreClient } from '../src/main/coreClient';
import type { DiscordApi } from '../src/main/discord/api';
import { AttachmentDownloader } from '../src/main/media/attachmentDownloader';
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

const source = (stored: string, fresh: string | undefined = undefined) => {
  const src: PosterSource & { refreshed: number; asked: number; thunk: () => Promise<PosterSource> } = {
    stored,
    refreshed: 0,
    asked: 0,
    fresh: async () => (src.refreshed++, fresh),
    thunk: async () => (src.asked++, src),
  };
  return src;
};
const dir = () => mkdtempSync(join(tmpdir(), 'cp-poster-'));
const text = (m: { bytes: Buffer } | null) => m && m.bytes.toString();

describe('attachmentPoster', () => {
  it('asks the media proxy for a still of the signed path, then serves it from the cache under any later signature', async () => {
    const { s, asked } = sessions(() => HTTP_OK);
    const d = dir();
    expect(text(await attachmentPoster(s, d, ID, source(signed('a')).thunk))).toBe(STILL);
    expect(asked).toHaveLength(1);
    expect(asked[0]!.hostname).toBe('media.discordapp.net');
    expect(asked[0]!.pathname).toBe(`/attachments/1/${ID}/clip.mov`);
    expect(asked[0]!.searchParams.get('hm')).toBe('a');
    expect(asked[0]!.searchParams.get('format')).toBe('webp');
    expect(text(await attachmentPoster(s, d, ID, source(signed('b')).thunk))).toBe(STILL);
    expect(asked).toHaveLength(1);
  });

  it('serves a kept still without asking where it comes from, so it outlives the attachment on Discord', async () => {
    const { s, asked } = sessions(() => HTTP_OK);
    const d = dir();
    await attachmentPoster(s, d, ID, source(signed('a')).thunk);
    const gone = async () => null;
    expect(text(await attachmentPoster(s, d, ID, gone))).toBe(STILL);
    expect(asked).toHaveLength(1);
    expect(await attachmentPoster(s, dir(), ID, gone)).toBeNull();
  });

  it('reads a fresh URL once when the stored one expired', async () => {
    const { s } = sessions((url) => (url.searchParams.get('hm') === 'old' ? HTTP_NOT_FOUND : HTTP_OK));
    const src = source(signed('old'), signed('new'));
    expect(text(await attachmentPoster(s, dir(), ID, src.thunk))).toBe(STILL);
    expect(src.refreshed).toBe(1);
  });

  it('gives none, without a refresh or a cached failure, when the proxy fails otherwise', async () => {
    let status = HTTP_GATEWAY_TIMEOUT;
    const { s } = sessions(() => status);
    const d = dir();
    const src = source(signed('a'), signed('b'));
    expect(await attachmentPoster(s, d, ID, src.thunk)).toBeNull();
    expect(src.refreshed).toBe(0);
    status = HTTP_OK;
    expect(text(await attachmentPoster(s, d, ID, src.thunk))).toBe(STILL);
  });

  it('fetches nothing for a URL off Discord’s attachment CDN', async () => {
    const { s, asked } = sessions(() => HTTP_OK);
    expect(await attachmentPoster(s, dir(), ID, source('https://example.com/clip.mov').thunk)).toBeNull();
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
    expect(attachmentSource(db, 'a1')).toEqual({ id: 'a1', messageId: m.id, channelId: GENERAL, url: signed('a1'), filename: 'a1.mov', contentType: null });
    archive.applyUpdate({ id: m.id, channel_id: GENERAL, attachments: [file('a2')] });
    expect(attachmentSource(db, 'a1')).toBeNull();
    archive.markDeleted(GENERAL, m.id, T0 + 1);
    expect(attachmentSource(db, 'a2')).toBeNull();
    expect(attachmentSource(db, 'missing')).toBeNull();
  });
});

describe('the downloader keeps a still for each video it archives', () => {
  const pending = (id: string, filename: string, contentType: string | null): PendingAttachment => ({
    id,
    messageId: 'm',
    channelId: 'c',
    url: signed(id),
    filename,
    contentType,
  });

  /** A downloader over `pending` (one batch) and `archived` (archivedVideos), keeping stills for ids not in `already`. */
  function run(pending: PendingAttachment[], archived: PendingAttachment[], already: string[] = []) {
    const queue = [pending];
    const stored: string[] = [];
    const kept: string[] = [];
    let backfills = 0;
    let drains = 0;
    const core = {
      call: async (method: string, id?: string) => {
        if (method === 'pendingAttachments') return (drains++, queue.shift() ?? []);
        if (method === 'archivedVideos') return (backfills++, archived);
        if (method === 'attachmentStored') stored.push(id!);
        return [];
      },
    } as unknown as CoreClient;
    const ses = { fetch: async () => new Response(new TextEncoder().encode('file')) } as unknown as Session;
    const posters = {
      kept: (id: string) => already.includes(id) || kept.includes(id),
      keep: async (a: PendingAttachment) => {
        kept.push(a.id);
        throw new Error('proxy down');
      },
    };
    const downloader = new AttachmentDownloader(dir(), dir(), ses, {} as DiscordApi, core, async () => ({ mediaMs: 0, jitter: 0 }) as never, async () => true, posters);
    downloader.kick();
    return { downloader, stored, kept, backfills: () => backfills, drains: () => drains };
  }

  it('asks for the still of a video, by content type or extension, and of nothing else; a failed one stores the file anyway', async () => {
    const r = run([pending('v1', 'clip.mov', null), pending('v2', 'clip.bin', 'video/mp4'), pending('i1', 'pic.png', 'image/png')], []);
    await vi.waitFor(() => expect(r.stored).toEqual(['v1', 'v2', 'i1']));
    expect(r.kept).toEqual(['v1', 'v2']);
  });

  it('keeps the stills of videos archived before, once per run, skipping kept ones and other files', async () => {
    const r = run([], [pending('old', 'clip.mp4', 'video/mp4'), pending('done', 'clip.mp4', 'video/mp4'), pending('doc', 'notes.bin', null)], ['done']);
    await vi.waitFor(() => expect(r.kept).toEqual(['old']));
    const before = r.drains();
    r.downloader.kick();
    await vi.waitFor(() => expect(r.drains()).toBeGreaterThan(before));
    await new Promise((resolve) => setTimeout(resolve));
    expect(r.backfills()).toBe(1);
  });
});
