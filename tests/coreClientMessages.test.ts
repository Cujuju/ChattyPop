import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const fakeProc = () => Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
let proc = fakeProc();
vi.mock('electron', () => ({ utilityProcess: { fork: () => proc } }));
const { CoreClient } = await import('../src/main/coreClient');

const init = { archiveDir: 'a', pluginsDir: 'p', pluginData: { root: 'r', unmoved: {} }, key: null, openRouterKeys: [], typeSafeKey: null, providerApiKeys: { probe: 'test-key' } };
const EXIT_CODE = 3;

/** Diagnostics events the client recorded. */
let reports: [string, Record<string, unknown>][] = [];
const freshCore = (): InstanceType<typeof CoreClient> => {
  proc = fakeProc();
  reports = [];
  return new CoreClient('core.js', init, (event, detail) => void reports.push([event, detail]));
};
/** Lets every queued promise reaction run. */
const flushed = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

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

describe("main's calls it doesn't wait for", () => {
  it("records a refused call and core's exit once, never leaving a rejection unhandled", async () => {
    const core = freshCore();
    core.tell('putGuildOrder', []);
    proc.emit('message', { id: 1, ok: false, error: 'no such table' });
    await flushed();
    expect(reports).toEqual([['core-call-failed', { method: 'putGuildOrder', message: 'no such table' }]]);
    core.tell('syncSettled');
    proc.emit('exit', EXIT_CODE);
    // Every call after the exit fails for that one reason: recorded once, as the exit.
    for (let i = 0; i < 3; i++) core.tell('syncSettled');
    await flushed();
    expect(reports.slice(1)).toEqual([['core-exited', { code: EXIT_CODE, stopped: false }]]);
  });

  it('records an exit after dispose as stopped', () => {
    const core = freshCore();
    core.dispose();
    proc.emit('exit', 0);
    expect(reports).toEqual([['core-exited', { code: 0, stopped: true }]]);
  });
});
