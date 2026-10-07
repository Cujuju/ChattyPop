import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

const proc = Object.assign(new EventEmitter(), { postMessage: vi.fn(), kill: vi.fn() });
vi.mock('electron', () => ({ utilityProcess: { fork: () => proc } }));
const { CoreClient } = await import('../src/main/coreClient');

const init = { archiveDir: 'a', pluginsDir: 'p', pluginData: { root: 'r', unmoved: {} }, key: null };

describe('CoreClient routes what core posts', () => {
  it('sends init milestones, events and answers each to its own listener', async () => {
    const core = new CoreClient('core.js', init);
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
