// The plugin testing harness (docs/plugin-architecture.md §15): a plugin tested through it meets the host's own adapters
// (lifetimes, read scope, audiences), and its public types reach no host module.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, PluginInactiveError, type CompletionRequest, type LlmProvider } from '@plugin-sdk/core';
import { testPlugin } from '@plugin-sdk/core/testing';

const manifest = (id: string) => ({ id, name: id, version: '1', description: '' });

/** A hosted provider that records what it was sent and answers at once. */
function hosted(): LlmProvider & { sent: CompletionRequest[] } {
  const sent: CompletionRequest[] = [];
  return { id: 'hostedai', maxInputChars: 100_000, sent, complete: async (req) => (sent.push(req), { text: 'ok' }), listModels: async () => [] };
}

describe('a plugin under the harness', () => {
  interface Calls {
    ask(channelId: string): string;
    wait(): string;
  }
  const probe = definePlugin({
    manifest: manifest('harnessprobe'),
    channels: defineChannels<{ core: Calls }>()({ core: { ask: ['renderer'], wait: ['renderer'] } }),
  });

  it('fences work that outlives the activation once off() resolves', async () => {
    let release!: () => void;
    const t = testPlugin(
      defineCorePlugin(probe, (ctx) =>
        ctx.channels.serve({
          ask: () => 'unused',
          wait: () => ctx.lifetime.fence(new Promise<string>((resolve) => (release = () => resolve('late')))),
        }),
      ),
    );
    onTestFinished(() => t.dispose());
    const pending = t.client('renderer').wait();
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    await t.off();
    release();
    await expect(pending).rejects.toBeInstanceOf(PluginInactiveError);
    await expect(t.client('renderer').ask('c1')).rejects.toBeInstanceOf(PluginInactiveError);
  });

  it("refuses a hosted provider a local-only channel's messages, sending nothing", async () => {
    const provider = hosted();
    const t = testPlugin(
      defineCorePlugin(probe, (ctx) =>
        ctx.channels.serve({
          ask: async (channelId) => (await ctx.ai.provider('hostedai').complete({ system: '', prompt: 'hi', reads: [channelId] })).text,
          wait: () => '',
        }),
      ),
      {
        archive: { channels: [{ id: 'open' }, { id: 'private', localOnly: true }] },
        ai: { providers: [{ id: 'hostedai', provider }] },
      },
    );
    onTestFinished(() => t.dispose());
    await expect(t.client('renderer').ask('open')).resolves.toBe('ok');
    await expect(t.client('renderer').ask('private')).rejects.toThrow('This channel is set to local AI only, so hostedai (hosted) may not read it.');
    expect(provider.sent).toHaveLength(1);
  });
});

describe("the harness's reach", () => {
  const ROOT = join(import.meta.dirname, '..');
  const SDK = join(ROOT, 'src/plugin-sdk');
  /** Every specifier a module names: imports and re-exports, types included. */
  const specifiers = (file: string): string[] => [...readFileSync(file, 'utf8').matchAll(/^\s*(?:import|export)\s[^'";]*?from\s+'([^']+)'/gm)].map((m) => m[1]!);
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? files(path) : /\.tsx?$/.test(name) ? [path] : [];
    });
  /** What a plugin's tests may see: the SDK's public entries. */
  const PUBLIC = /^@plugin-sdk\/(shared|core|main|renderer)(\/(kit|shell|testing))?$/;

  it.each(['core/testing/types.ts', 'main/testing/types.ts', 'renderer/testing/types.ts', 'shared/testing/index.ts'])('%s names only public SDK entries', (file) => {
    expect(specifiers(join(SDK, file)).filter((spec) => !PUBLIC.test(spec))).toEqual([]);
  });

  it('no app module imports a testing entry, so none is bundled', () => {
    const testing = (spec: string): boolean => /(^@plugin-sdk\/\w+\/testing|\/testing(\/\w+)?)$/.test(spec);
    const inTesting = (file: string): boolean => relative(SDK, file).replaceAll('\\', '/').split('/')[1] === 'testing';
    const offenders = files(join(ROOT, 'src')).filter((file) => !inTesting(file) && specifiers(file).some(testing));
    expect(offenders.map((f) => relative(ROOT, f))).toEqual([]);
  });
});
