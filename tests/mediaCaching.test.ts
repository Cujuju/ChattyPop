// Content-addressed media (a new picture, a new address) is kept by the phone's browser; anything else isn't.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from './helpers';

vi.mock('electron', () => ({ protocol: {}, app: { getPath: () => '' } }));

const { mediaHandler } = await import('../src/main/media/mediaProtocol');
const { mediaDirs } = await import('../src/main/media/mediaDirs');

const USER = '1000000000000000001';
const HASH = 'a'.repeat(32);

describe('media caching', () => {
  it('keeps a stored avatar for a year, privately; never a failure', async () => {
    const dirs = mediaDirs(tempDir());
    mkdirSync(dirs.avatars, { recursive: true });
    writeFileSync(join(dirs.avatars, `${USER}-${HASH}.webp`), 'img');
    const session = { fetch: async () => new Response(null, { status: 404 }) };
    const page = { fontUrl: async () => null, load: async () => new Response(null, { status: 502 }) };
    const serve = mediaHandler(dirs, { discord: session, web: session } as never, page, async () => null);
    const avatar = await serve(new URL(`cp-media://avatar/${USER}/${HASH}`));
    expect(avatar.status).toBe(200);
    expect(avatar.headers.get('cache-control')).toBe('private, max-age=31536000, immutable');
    const missing = await serve(new URL(`cp-media://avatar/${USER}/${'b'.repeat(32)}`));
    expect(missing.status).toBe(404);
    expect(missing.headers.get('cache-control')).toBeNull();
  });
});
