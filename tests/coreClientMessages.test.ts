import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const fakeProc = () => Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
let proc = fakeProc();
vi.mock('electron', () => ({ utilityProcess: { fork: () => proc } }));
const { CoreClient } = await import('../src/main/coreClient');

const init = { archiveDir: 'a', pluginsDir: 'p', pluginData: { root: 'r', unmoved: {} }, key: null, openRouterKeys: [], typeSafeKey: null, providerApiKeys: { probe: 'test-key' } };
const EXIT_CODE = 3;

const freshCore = (): InstanceType<typeof CoreClient> => {
  proc = fakeProc();
  return new CoreClient('core.js', init);
};

describe('CoreClient routes what core posts', () => {
  it('sends init milestones, events and answers each to its own listener', async () => {
    const core = freshCore();
    expect(proc.postMessage).toHaveBeenNthCalledWith(1, { kind: 'init', ...init });
    const steps: unknown[] = [];
    const events: unknown[] = [];
    core.on('init-step', (s) => steps.push(s));
    core.on('event', (e) => events.push(e));
    const answer = core.call('selfId');
    proc.emit('message', { kind: 'init-step', step: 'loaded' });
    proc.emit('message', { kind: 'init-step', step: 'database' });
    proc.emit('message', { kind: 'event', event: { type: 'plugins-changed' } });
    proc.emit('message', { id: 1, ok: true, result: 'me' });
    expect(steps).toEqual(['loaded', 'database']);
    expect(events).toEqual([{ type: 'plugins-changed' }]);
    await expect(answer).resolves.toBe('me');
  });
});

describe('CoreClient once core has ended', () => {
  it('rejects calls pending at exit and every later call with the exit, posting nothing', async () => {
    const core = freshCore();
    const pending = core.call('selfId');
    proc.emit('exit', EXIT_CODE);
    await expect(pending).rejects.toThrow(`core exited with code ${EXIT_CODE}`);
    proc.postMessage.mockClear();
    await expect(core.call('selfId')).rejects.toThrow(`core exited with code ${EXIT_CODE}`);
    expect(proc.postMessage).not.toHaveBeenCalled();
  });

  it('rejects pending and later calls after dispose, and keeps that reason when the exit follows', async () => {
    const core = freshCore();
    const pending = core.call('selfId');
    core.dispose();
    expect(proc.kill).toHaveBeenCalled();
    await expect(pending).rejects.toThrow('core was stopped');
    proc.emit('exit', 0);
    await expect(core.call('selfId')).rejects.toThrow('core was stopped');
  });

  it('rejects a call whose message cannot be posted, leaving later calls working', async () => {
    const core = freshCore();
    proc.postMessage.mockImplementationOnce(() => { throw new Error('post failed'); });
    await expect(core.call('selfId')).rejects.toThrow('post failed');
    const answer = core.call('selfId');
    proc.emit('message', { id: 2, ok: true, result: 'me' });
    await expect(answer).resolves.toBe('me');
  });
});
