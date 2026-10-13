// The phone's shared emoji URLs use the native cache only when the installed app promises its versioned handler.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_CAPABILITIES, SHELL_NATIVE_GLOBAL } from '@shared/shell';

const EMOJI_ID = '1000000000000000001';
const TRANSPORT = '@plugin-sdk/renderer/shell/transport';

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal('window', {});
});
afterEach(() => vi.unstubAllGlobals());

async function install(mediaRoot: string, shell: unknown) {
  vi.stubGlobal(SHELL_NATIVE_GLOBAL, shell);
  // A path import keeps renderer DOM types outside the node type-check.
  const { installRendererApi } = (await import(TRANSPORT)) as { installRendererApi(api: unknown, root: string): void };
  installRendererApi({}, mediaRoot);
  return { ...(await import('@shared/media')), ...(await import('@shared/emoji')) };
}

describe('native emoji routing', () => {
  it.each([
    ['browser', undefined],
    ['older app', { apsEnvironment: 'development' }],
    ['photo-capable app', { capabilities: [SHELL_CAPABILITIES.photoLibrary] }],
    ['malformed capability list', { capabilities: 'emojiCache' }],
    ['unknown capability', { capabilities: ['emojiCacheV2'] }],
  ])('keeps the desktop media URLs in a %s', async (_name, shell) => {
    const { emojiUrl } = await install('/media/', shell);
    expect(emojiUrl({ id: EMOJI_ID, animated: false })).toBe(`/media/emoji/${EMOJI_ID}.webp`);
    expect(emojiUrl({ id: EMOJI_ID, animated: true })).toBe(`/media/emoji/${EMOJI_ID}.gif`);
  });

  it('routes both emoji representations to v1, preserving all other media routes', async () => {
    const { emojiUrl, avatarUrl, attachmentUrl, lottieStickerUrl } = await install('/media/', { capabilities: [SHELL_CAPABILITIES.emojiCache] });
    expect(emojiUrl({ id: EMOJI_ID, animated: false })).toBe(`chattypop-asset://emoji/v1/${EMOJI_ID}.webp`);
    expect(emojiUrl({ id: EMOJI_ID, animated: true })).toBe(`chattypop-asset://emoji/v1/${EMOJI_ID}.gif`);
    expect(avatarUrl(EMOJI_ID, null)).toBe(`/media/avatar/${EMOJI_ID}/default`);
    expect(attachmentUrl({ sha256: 'a'.repeat(64), filename: 'image.png', storedExt: null })).toBe(`/media/attachment/${'a'.repeat(64)}.png`);
    expect(lottieStickerUrl(EMOJI_ID)).toBe(`/media/sticker/${EMOJI_ID}.json`);
  });

  it('keeps another transport media root because the native download contract uses /media/', async () => {
    const { emojiUrl } = await install('/custom-media/', { capabilities: [SHELL_CAPABILITIES.emojiCache] });
    expect(emojiUrl({ id: EMOJI_ID, animated: false })).toBe(`/custom-media/emoji/${EMOJI_ID}.webp`);
  });

  it('clears native overrides when the media root is replaced', async () => {
    const { emojiUrl, setMediaRoot } = await install('/media/', { capabilities: [SHELL_CAPABILITIES.emojiCache] });
    setMediaRoot('cp-media://');
    expect(emojiUrl({ id: EMOJI_ID, animated: true })).toBe(`cp-media://emoji/${EMOJI_ID}.gif`);
    setMediaRoot('/media/');
    expect(emojiUrl({ id: EMOJI_ID, animated: false })).toBe(`/media/emoji/${EMOJI_ID}.webp`);
  });

  it('sets native URLs before releasing renderer calls queued during startup', async () => {
    vi.stubGlobal(SHELL_NATIVE_GLOBAL, { capabilities: [SHELL_CAPABILITIES.emojiCache] });
    const leaf = '@/api';
    const { api } = (await import(leaf)) as { api: { core: { status(): Promise<string> } } };
    const waiting = api.core.status();
    const { emojiUrl } = await import('@shared/emoji');
    const { installRendererApi } = (await import(TRANSPORT)) as { installRendererApi(api: unknown, root: string): void };
    installRendererApi({ core: { status: () => emojiUrl({ id: EMOJI_ID, animated: false }) } }, '/media/');
    await expect(waiting).resolves.toBe(`chattypop-asset://emoji/v1/${EMOJI_ID}.webp`);
  });
});
