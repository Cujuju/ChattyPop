// Page scripts run in one isolated world per document: created once, recreated after a navigation or a stale context.
import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import { PageWorld } from '../src/main/discord/pageWorld';

/** A page whose debugger answers CDP; `stale` context ids fail as a replaced document's do. */
function fakePage() {
  const page = new EventEmitter();
  const sent: { method: string; params?: Record<string, unknown> }[] = [];
  const stale = new Set<number>();
  let nextContext = 1;
  const sendCommand = async (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    sent.push({ method, params });
    if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main' } } };
    if (method === 'Page.createIsolatedWorld') return { executionContextId: nextContext++ };
    if (stale.has(params!['contextId'] as number)) throw new Error('Cannot find context with specified id');
    if (params!['expression'] === 'throw') return { result: {}, exceptionDetails: { text: 'Uncaught', exception: { description: 'Error: boom' } } };
    return { result: { value: `${String(params!['expression'])}@${String(params!['contextId'])}` } };
  };
  return { page: Object.assign(page, { debugger: { sendCommand } }), sent, stale };
}

describe('page world', () => {
  it('creates the world once per document, in the main frame, and evaluates there', async () => {
    const p = fakePage();
    const world = new PageWorld(p.page as never);
    expect(await world.evaluate('a')).toBe('a@1');
    expect(await world.evaluate('b')).toBe('b@1');
    expect(p.sent.filter((c) => c.method === 'Page.createIsolatedWorld')).toEqual([{ method: 'Page.createIsolatedWorld', params: { frameId: 'main', worldName: 'isolated' } }]);
    expect(p.sent.find((c) => c.method === 'Runtime.evaluate')?.params).toMatchObject({ contextId: 1, awaitPromise: true, returnByValue: true });
    p.page.emit('did-navigate');
    expect(await world.evaluate('c')).toBe('c@2');
  });

  it('recreates a stale world once, and rejects with what a script threw', async () => {
    const p = fakePage();
    const world = new PageWorld(p.page as never);
    await world.evaluate('a');
    p.stale.add(1);
    expect(await world.evaluate('b')).toBe('b@2');
    await expect(world.evaluate('throw')).rejects.toThrow('Error: boom');
  });
});
