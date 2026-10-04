// Windows' calls to plugins' main sides: refused centrally while the plugin is off, so no dialog opens for one; a main
// activation that fails or leaves a declared call unserved registers nothing.
import { describe, expect, it, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineMainPlugin } from '@plugin-sdk/main';
import { MAIN_INVOKE } from '@shared/contract';
import type { PluginCallResult } from '@shared/pluginCall';
import type { PluginInfo } from '@shared/plugins';

const env = vi.hoisted(() => ({ ipc: new Map<string, (...args: unknown[]) => unknown>(), dialogs: 0 }));
vi.mock('electron', () => ({
  app: { getPath: () => '' },
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => unknown) => void env.ipc.set(channel, fn) },
}));

const { PluginStates } = await import('../src/main/plugins/states');
const { startMainPlugins } = await import('../src/main/plugins/bundled');
/** A main side whose calls each open the owner's file or folder dialog, cancelled, before any work. */
const dialogPlugin = definePlugin({
  manifest: { id: 'dialogs', name: 'Dialogs', version: '1', description: '' },
  channels: defineChannels<{ main: { importFiles(): null; exportFolder(): null } }>()({ main: { importFiles: ['renderer'], exportFolder: ['renderer'] } }),
});
const dialogMain = defineMainPlugin(dialogPlugin, (ctx) => {
  ctx.channels.serve({
    importFiles: async () => (await ctx.dialogs.pickFiles('Import', [{ name: 'JSON', extensions: ['json'] }]), null),
    exportFolder: async () => (await ctx.dialogs.pickFolder('Export to folder'), null),
  });
});
/** The owner cancels every file and folder dialog; each one opened is counted. */
const dialogs = {
  pickFiles: async () => (env.dialogs++, []),
  pickFolder: async () => (env.dialogs++, null),
};

describe('a window calling a main side', () => {
  it('gets the inactive answer, and no dialog opens, once core has the plugin off', async () => {
    let on = true;
    const list = async (): Promise<PluginInfo[]> => (on ? [{ id: 'dialogs', bundled: true, status: 'active' } as PluginInfo] : []);
    const states = new PluginStates(list, () => undefined);
    startMainPlugins([dialogMain], { core: { call: async () => list(), on: () => undefined }, states, dialogs, diag: () => undefined } as never);
    const call = (name: string) => env.ipc.get(MAIN_INVOKE.plugins.callMain)!({}, 'dialogs', name, []) as Promise<PluginCallResult>;
    await expect(call('importFiles')).resolves.toEqual({ status: 'ok', value: null });
    expect(env.dialogs).toBe(1);
    // Core turned it off; main's snapshot has not caught up yet.
    on = false;
    await expect(call('importFiles')).resolves.toEqual({ status: 'inactive', pluginId: 'dialogs' });
    await expect(call('exportFolder')).resolves.toEqual({ status: 'inactive', pluginId: 'dialogs' });
    expect(env.dialogs).toBe(1);
  });
});

describe('a main activation', () => {
  const probe = (id: string) =>
    definePlugin({
      manifest: { id, name: id, version: '1', description: '' },
      channels: defineChannels<{ main: { pick(): string } }>()({ main: { pick: ['renderer'] } }),
      phone: { routes: ['file'] },
    });
  // As ipcMain.handle answers: a throw rejects the window's invoke.
  const call = async (id: string): Promise<unknown> => env.ipc.get(MAIN_INVOKE.plugins.callMain)!({}, id, 'pick', []);

  it('that serves no declared call, or throws, is logged and registers nothing; the others start', async () => {
    const started: string[] = [];
    const unserved = defineMainPlugin(probe('unserved'), (ctx) => ctx.whileActive(() => void started.push('unserved')));
    const throwing = defineMainPlugin(probe('throwing'), (ctx) => {
      ctx.whileActive(() => void started.push('throwing'));
      ctx.live.labels.provide(async () => ({}));
      ctx.phone.route('file', () => null as never);
      ctx.channels.serve({ pick: () => 'picked' });
      throw new Error('broken');
    });
    const good = defineMainPlugin(probe('good'), (ctx) => {
      ctx.whileActive(() => void started.push('good'));
      ctx.live.labels.provide(async () => ({}));
      ctx.phone.route('file', () => null as never);
      ctx.channels.serve({ pick: () => 'picked' });
    });
    const states = new PluginStates(async () => [], () => undefined);
    const on = vi.spyOn(states, 'active').mockReturnValue(true);
    vi.spyOn(states, 'confirmed').mockResolvedValue(true);
    const diag = vi.fn();
    const labelled: string[] = [];
    const routed: string[] = [];
    const liveLabels = { provide: (id: string) => void labelled.push(id), changed: () => undefined };
    const phone = { route: (id: string) => void routed.push(id) };
    startMainPlugins([unserved, throwing, good], { core: { call: async () => [], on: () => undefined }, states, liveLabels, phone, diag } as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(diag.mock.calls).toEqual([
      ['plugin-activation-failed', { pluginId: 'unserved', message: 'unserved declares but never served main calls: pick' }],
      ['plugin-activation-failed', { pluginId: 'throwing', message: 'broken' }],
    ]);
    expect(started).toEqual(['good']);
    expect([labelled, routed]).toEqual([['good'], ['good']]);
    await expect(call('throwing')).rejects.toThrow(/no main function pick/);
    await expect(call('unserved')).rejects.toThrow(/no main function pick/);
    await expect(call('good')).resolves.toEqual({ status: 'ok', value: 'picked' });
    on.mockRestore();
  });
});
