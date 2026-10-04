// A main side's ctx.discord: reads for every plugin, writes only with descriptor `discord: { write: true }`, and never
// the host's client itself (docs/plugin-architecture.md §4). Reads are paced; writes aren't, an automatic post's one wait
// being humanPause. The type side is src/plugin-sdk/main/services.typecheck.ts.
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginDescriptor } from '@plugin-sdk/shared';
import type { DiscordClient } from '../src/main/discord/client';

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => undefined } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { createMainContext } = await import('../src/main/plugins/context');

const WRITES = ['post', 'postOnce', 'put', 'patch', 'delete', 'upload'] as const;

/** A host client recording each request as `<verb> <path>`. */
function hostClient(): DiscordClient & { sent: string[] } {
  const sent: string[] = [];
  const record = (verb: string) => async (path: string) => void sent.push(`${verb} ${path}`);
  return {
    sent,
    get: async <T>(path: string) => {
      sent.push(`get ${path}`);
      return [] as T;
    },
    post: record('post') as DiscordClient['post'],
    postOnce: record('postOnce') as DiscordClient['postOnce'],
    put: record('put'),
    patch: record('patch') as DiscordClient['patch'],
    delete: record('delete'),
    upload: record('upload'),
  };
}

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
/** The host's two lanes and its pause, each recording what reaches it. */
function host() {
  const paced = hostClient();
  const prompt = hostClient();
  const pauses: number[] = [];
  return { paced, prompt, pauses, discord: { paced, prompt, humanPause: async () => void pauses.push(pauses.length), posting: { unlocked: async () => true } } };
}

const contextFor = <D extends PluginDescriptor>(plugin: D, h: ReturnType<typeof host>) =>
  createMainContext(plugin, { discord: h.discord, emojiIndex: { all: () => [], forGuild: (api: DiscordClient, id: string) => api.get(`guilds/${id}/emojis`) } } as never, {} as never);

describe('main ctx.discord', () => {
  it('has no write member for a plugin that does not declare discord.write', async () => {
    const h = host();
    const ctx = contextFor(definePlugin({ manifest: manifest('reader') }), h);
    for (const verb of [...WRITES, 'humanPause']) {
      expect(verb in ctx.discord).toBe(false);
      expect(Reflect.get(ctx.discord, verb)).toBeUndefined();
    }
    await ctx.discord.get('users/@me');
    await ctx.emojis.forGuild('g1');
    expect(h.paced.sent).toEqual(['get users/@me', 'get guilds/g1/emojis']);
    expect(h.prompt.sent).toEqual([]);
    expect(ctx.discord).not.toBe(h.paced);
  });

  it('writes unpaced and reads paced for a plugin that declares discord.write, with the host pause as its one wait', async () => {
    const h = host();
    const ctx = contextFor(definePlugin({ manifest: manifest('writer'), discord: { write: true } }), h);
    await ctx.discord.humanPause();
    await ctx.discord.get('users/@me');
    await ctx.discord.post('channels/1/messages', {});
    await ctx.discord.postOnce('channels/1/threads', {});
    await ctx.discord.put('channels/1/messages/2/reactions/x/@me');
    await ctx.discord.patch('channels/1/messages/2', {});
    await ctx.discord.delete('channels/1/messages/2');
    await ctx.discord.upload('https://upload.example/slot', Buffer.from('x'));
    expect(h.pauses).toHaveLength(1);
    expect(h.paced.sent).toEqual(['get users/@me']);
    expect(h.prompt.sent).toEqual([
      'post channels/1/messages',
      'postOnce channels/1/threads',
      'put channels/1/messages/2/reactions/x/@me',
      'patch channels/1/messages/2',
      'delete channels/1/messages/2',
      'upload https://upload.example/slot',
    ]);
    expect(ctx.discord).not.toBe(h.prompt);
  });
});
