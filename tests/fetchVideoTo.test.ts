// ctx.media.fetchVideoTo (docs/plugin-architecture.md, Main image fetch): an embed's video through the Discord session;
// video, audio or untyped bytes only.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Session } from 'electron';
import { describe, expect, it } from 'vitest';
import { fetchVideoTo, type MediaSessions } from '../src/main/media/thumbStore';

const VIDEO = 'https://media.discordapp.net/external/v/clip.mp4';
const BYTES = 'video bytes';

/** Sessions whose Discord one answers every fetch with BYTES and `headers`. */
function sessions(headers: Record<string, string>): MediaSessions {
  // Bytes, not a string: a string body would be given a text content type.
  const fetch = async () => new Response(new TextEncoder().encode(BYTES), { headers });
  return { discord: { fetch } as unknown as Session, web: {} as Session };
}

describe('fetchVideoTo', () => {
  it.each<Record<string, string>>([{ 'content-type': 'video/mp4' }, {}])('writes a video, or bytes of no stated type (%o)', async (headers) => {
    const path = join(mkdtempSync(join(tmpdir(), 'cp-video-')), 'clip.mp4');
    expect(await fetchVideoTo(sessions(headers), VIDEO, path)).toBeNull();
    expect(readFileSync(path, 'utf8')).toBe(BYTES);
  });

  it('refuses an error page', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'cp-video-')), 'clip.mp4');
    expect(await fetchVideoTo(sessions({ 'content-type': 'text/html' }), VIDEO, path)).toBe('Not a video (text/html).');
  });
});
