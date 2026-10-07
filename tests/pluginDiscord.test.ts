// Plugins receive paced Discord reads. Descriptor-authorized writes bypass read pacing; automatic posts use humanPause and are spaced. Only the
// client's own routes go; the host client remains private.
import { describe, expect, it, vi } from 'vitest';
import { definePlugin, type PluginDescriptor } from '@plugin-sdk/shared';
import type { DiscordClient } from '../src/main/discord/client';

vi.mock('electron', () => ({ app: { getPath: () => '' }, dialog: {}, ipcMain: { handle: () => undefined } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { createMainContext } = await import('../src/main/plugins/context');
const { ActionSpacer } = await import('../src/main/plugins/discordContext');

const C = '1000000000000000001';
const M = '1000000000000000002';
const G = '1000000000000000003';

const WRITES = ['post', 'postOnce', 'put', 'putJson', 'patch', 'delete', 'upload'] as const;

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
    putJson: record('putJson') as DiscordClient['putJson'],
    patch: record('patch') as DiscordClient['patch'],
    delete: record('delete'),
    upload: record('upload'),
  };
}

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });
/** The host's two lanes and its pause, each recording what reaches it. */
function host(gap = 0) {
  const paced = hostClient();
  const prompt = hostClient();
  const pauses: number[] = [];
  const spacer = new ActionSpacer(async () => gap);
  return { paced, prompt, pauses, discord: { paced, prompt, humanPause: async () => void pauses.push(pauses.length), posting: { unlocked: async () => true }, spacer } };
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
    await ctx.discord.get(`channels/${C}/messages`, { limit: 50 });
    await ctx.emojis.forGuild(G);
    expect(h.paced.sent).toEqual([`get channels/${C}/messages`, `get guilds/${G}/emojis`]);
    expect(h.prompt.sent).toEqual([]);
    expect(ctx.discord).not.toBe(h.paced);
  });

  it('writes unpaced and reads paced for a plugin that declares discord.write, with the host pause as its one wait', async () => {
    const h = host();
    const ctx = contextFor(definePlugin({ manifest: manifest('writer'), discord: { write: true } }), h);
    await ctx.discord.humanPause();
    await ctx.discord.get(`channels/${C}/messages`);
    await ctx.discord.post(`channels/${C}/messages`, {});
    await ctx.discord.postOnce(`channels/${C}/attachments`, {});
    await ctx.discord.put(`channels/${C}/messages/${M}/reactions/x/@me`);
    await ctx.discord.patch(`channels/${C}/messages/${M}`, {});
    await ctx.discord.delete(`channels/${C}/messages/${M}`);
    await ctx.discord.upload('https://upload.example/slot', Buffer.from('x'));
    expect(h.pauses).toHaveLength(1);
    expect(h.paced.sent).toEqual([`get channels/${C}/messages`]);
    expect(h.prompt.sent).toEqual([
      `post channels/${C}/messages`,
      `postOnce channels/${C}/attachments`,
      `put channels/${C}/messages/${M}/reactions/x/@me`,
      `patch channels/${C}/messages/${M}`,
      `delete channels/${C}/messages/${M}`,
      'upload https://upload.example/slot',
    ]);
    expect(ctx.discord).not.toBe(h.prompt);
  });

  it("refuses routes the client doesn't send for plugins, and paths outside the API, before anything goes", async () => {
    const h = host();
    const ctx = contextFor(definePlugin({ manifest: manifest('writer'), discord: { write: true } }), h);
    await expect(ctx.discord.get('users/@me/guilds')).rejects.toThrow('Plugins may not call');
    await expect(ctx.discord.get(`guilds/${G}/channels`)).rejects.toThrow('Plugins may not call');
    await expect(ctx.discord.post(`channels/${C}/threads`, {})).rejects.toThrow('Plugins may not call');
    await expect(ctx.discord.get('https://example.com/steal')).rejects.toThrow('Not a Discord API path');
    expect([...h.paced.sent, ...h.prompt.sent]).toEqual([]);
  });

  it("spaces automatic actions a pause apart across plugins; an action's attachment slot and acks go straight", async () => {
    vi.useFakeTimers();
    try {
      const GAP_MS = 5000;
      const h = host(GAP_MS);
      const a = contextFor(definePlugin({ manifest: manifest('a'), discord: { write: true } }), h);
      const b = contextFor(definePlugin({ manifest: manifest('b'), discord: { write: true } }), h);
      const first = a.discord.post(`channels/${C}/messages`, {});
      const second = b.discord.post(`channels/${C}/messages`, {});
      await vi.advanceTimersByTimeAsync(0);
      await first;
      expect(h.prompt.sent).toHaveLength(1);
      await b.discord.post(`channels/${C}/attachments`, {});
      expect(h.prompt.sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(GAP_MS - 1);
      expect(h.prompt.sent).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      await second;
      expect(h.prompt.sent).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
