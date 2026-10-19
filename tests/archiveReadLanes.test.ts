import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReadPriority } from '../src/shared/readPriority';
import type { ReadQuery } from '../src/core/reads/protocol';

const fixture = vi.hoisted(() => ({ children: [] as FakeChild[] }));
class FakeChild extends EventEmitter {
  sent: ReadQuery[] = [];
  kill = vi.fn(() => { queueMicrotask(() => this.emit('close')); return true; });
  send(message: ReadQuery, done: (error: Error | null) => void): void {
    if ('sql' in message) this.sent.push(message);
    done(null);
  }
  finish(): void { this.emit('message', { kind: 'rows', rows: [{ done: this.sent.at(-1)!.sql }] }); }
}
vi.mock('node:child_process', () => ({ fork: () => { const child = new FakeChild(); fixture.children.push(child); return child; } }));
const { ArchiveReadPool, ARCHIVE_READ_INTERACTIVE_BURST, ARCHIVE_READ_INTERACTIVE_QUEUE_MAX, ARCHIVE_READ_BACKGROUND_QUEUE_MAX } = await import('../src/core/reads/pool');
let pool: InstanceType<typeof ArchiveReadPool>;
const jobs: Promise<unknown>[] = [];
const read = (sql: string, lane: ReadPriority = 'background', signal?: AbortSignal) => {
  const work = pool.read(sql, [], signal, lane);
  jobs.push(work.catch(() => undefined));
  return work;
};
beforeEach(() => { fixture.children.length = 0; pool = new ArchiveReadPool({ path: 'unused', key: null }); });
afterEach(async () => { await pool.close(); await Promise.all(jobs.splice(0)); });
const occupy = () => { void read('active-a'); void read('active-b'); };

describe('archive read lane contracts', () => {
  it('settles every shared consumer when one fulfillment aborts another', async () => {
    occupy();
    const control = new AbortController();
    const first = read('shared-reply');
    void first.then(() => control.abort(new Error('cancel during fulfillment')));
    const second = read('shared-reply', 'background', control.signal);
    const third = read('shared-reply', 'background', new AbortController().signal);
    const child = fixture.children[0]!;
    child.finish();
    child.finish();
    await expect(first).resolves.toEqual([{ done: 'shared-reply' }]);
    await expect(second).rejects.toBe(control.signal.reason);
    await expect(third).resolves.toEqual([{ done: 'shared-reply' }]);
  });

  it('dispatches interactive work ahead of queued background work', async () => {
    occupy();
    void read('background');
    const visible = read('interactive', 'interactive');
    const child = fixture.children[0]!;
    child.finish();
    expect(child.sent.at(-1)!.sql).toBe('interactive');
    child.finish();
    await expect(visible).resolves.toEqual([{ done: 'interactive' }]);
    expect(child.sent.at(-1)!.sql).toBe('background');
  });

  it('shares an identical queued promise within its lane, including at capacity', async () => {
    occupy();
    const first = read('same');
    expect(read('same')).toBe(first);
    for (let i = 1; i < ARCHIVE_READ_BACKGROUND_QUEUE_MAX; i++) void read(`background-${i}`);
    expect(read('same')).toBe(first);
    await expect(read('overflow')).rejects.toThrow('background read queue is full');
    const interactive = read('same', 'interactive');
    expect(interactive).not.toBe(first);
    for (let i = 1; i < ARCHIVE_READ_INTERACTIVE_QUEUE_MAX; i++) void read(`interactive-${i}`, 'interactive');
    await expect(read('overflow', 'interactive')).rejects.toThrow('interactive read queue is full');
  });

  it('bounds background starvation while interactive reads keep arriving', () => {
    occupy();
    void read('background');
    for (let i = 0; i <= ARCHIVE_READ_INTERACTIVE_BURST; i++) void read(`visible-${i}`, 'interactive');
    const child = fixture.children[0]!;
    for (let i = 0; i <= ARCHIVE_READ_INTERACTIVE_BURST; i++) {
      child.finish();
      if (child.sent.at(-1)!.sql === 'background') break;
      void read(`new-visible-${i}`, 'interactive');
    }
    expect(child.sent.at(-1)!.sql).toBe('background');
  });

  it('drops queued cancelled work and kills only the active cancelled helper', async () => {
    const active = new AbortController(), queued = new AbortController();
    const running = read('active', 'background', active.signal);
    void read('other');
    const waiting = read('queued', 'background', queued.signal);
    queued.abort(new Error('drop queued'));
    await expect(waiting).rejects.toBe(queued.signal.reason);
    expect(fixture.children.every((child) => !child.kill.mock.calls.length)).toBe(true);
    active.abort(new Error('stop active'));
    await expect(running).rejects.toBe(active.signal.reason);
    expect(fixture.children[0]!.kill).toHaveBeenCalledOnce();
    expect(fixture.children[1]!.kill).not.toHaveBeenCalled();
    fixture.children[1]!.finish();
    expect(fixture.children.flatMap((child) => child.sent).some((q) => q.sql === 'queued')).toBe(false);
  });

  it('retains shared work until its last consumer cancels', async () => {
    occupy();
    const a = new AbortController(), b = new AbortController();
    const first = read('shared', 'background', a.signal);
    const second = read('shared', 'background', b.signal);
    a.abort();
    await expect(first).rejects.toBe(a.signal.reason);
    const child = fixture.children[0]!;
    child.finish();
    expect(child.sent.at(-1)!.sql).toBe('shared');
    expect(child.kill).not.toHaveBeenCalled();
    b.abort();
    await expect(second).rejects.toBe(b.signal.reason);
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
