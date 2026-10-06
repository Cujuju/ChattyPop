// Ended core activations and main resource runs reject retained side effects, including writes, importers, and fetches. Reads remain available.
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin, type CoreContext, type PluginStatement } from '@plugin-sdk/core';
import type { AppEvent } from '@shared/contract';
import { PluginInactiveError } from '@shared/pluginCall';
import { testPlugin } from '@plugin-sdk/core/testing';
import { tempDb, tempDir } from './helpers';
import { pluginDb } from '../src/core/plugins/pluginDb';

const env = vi.hoisted(() => ({ userData: '' }));
vi.mock('electron', () => ({
  app: { getPath: () => env.userData },
  dialog: {},
  safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from(`enc:${s}`), decryptString: (b: Buffer) => b.toString().slice('enc:'.length) },
}));
const { createMainContext } = await import('../src/main/plugins/context');
const { whileActive } = await import('../src/main/plugins/states');
const { rendererPages } = await import('../src/main/plugins/pages');
const { SECRET_FILES } = await import('../src/main/secretFile');

const HOST = 'fence.example.com';
const probe = definePlugin({
  manifest: { id: 'fence', name: 'fence', version: '1', description: '' },
  network: { hosts: [HOST] },
  channels: defineChannels<{ events: { shown: number } }>()({ events: { shown: ['renderer'] } }),
});
type Ctx = CoreContext<typeof probe>;
/** A request whose server never answers, and ignores the abort: the network behind both sides' fetch. */
const hanging = vi.fn(() => new Promise<Response>(() => undefined));
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
/** What `p` settles with (its value or error), observed from the start so a rejection before the assert isn't unhandled. */
const outcome = (p: Promise<unknown>): Promise<unknown> => p.then((v) => v, (err: unknown) => err);

beforeEach(() => {
  env.userData = tempDir();
  hanging.mockClear();
  vi.stubGlobal('fetch', hanging);
});
afterEach(() => void vi.unstubAllGlobals());

/** What the probe's first activation holds on to past its end. */
interface Held {
  ctx: Ctx;
  insert: PluginStatement<[string]>;
  /** A pluck()ed write: INSERT … RETURNING. */
  inserted: PluginStatement<[string], string>;
  count: PluginStatement<[], number>;
  tx: (v: string) => void;
}

function start() {
  const held: Held[] = [];
  const t = testPlugin(
    defineCorePlugin(probe, (ctx) => {
      const rows = ctx.storage.table('rows');
      ctx.storage.migrate([`CREATE TABLE ${rows} (v TEXT)`]);
      const insert = ctx.storage.db.prepare<[string]>(`INSERT INTO ${rows} (v) VALUES (?)`);
      held.push({
        ctx,
        insert,
        inserted: ctx.storage.db.prepare<[string], string>(`INSERT INTO ${rows} (v) VALUES (?) RETURNING v`).pluck(),
        count: ctx.storage.db.prepare<[], number>(`SELECT COUNT(*) FROM ${rows}`).pluck(),
        tx: ctx.storage.db.transaction((v: string) => void insert.run(v)),
      });
    }),
    { network: hanging },
  );
  onTestFinished(() => t.dispose());
  return { held: held[0]!, off: () => t.off(), on: () => t.on() };
}

describe('a core activation’s fence', () => {
  it('refuses writes through a held statement, a pluck()ed one and a transaction once off, even after on again; reads still work', async () => {
    const { held, off, on } = start();
    held.insert.run('a');
    expect(held.inserted.get('b')).toBe('b');
    held.tx('c');
    held.ctx.storage.transaction(() => held.insert.run('d'));
    await off();
    await on();
    expect(() => held.insert.run('x')).toThrow(PluginInactiveError);
    expect(() => held.inserted.get('x')).toThrow(PluginInactiveError);
    expect(() => held.tx('x')).toThrow(PluginInactiveError);
    expect(() => held.ctx.storage.transaction(() => held.insert.run('x'))).toThrow(PluginInactiveError);
    expect(held.count.get()).toBe(4);
    expect(held.ctx.storage.transaction(() => held.count.get())).toBe(4);
  });

  it('refuses a held importer’s writes once off', async () => {
    const { held, off } = start();
    const importer = held.ctx.archive.store();
    expect(importer.atomically(() => 1)).toBe(1);
    await off();
    expect(() => importer.atomically(() => 1)).toThrow(PluginInactiveError);
  });

  it('settles a fetch still waiting with PluginInactiveError when turned off, and sends none after', async () => {
    const { held, off } = start();
    const waiting = held.ctx.net.fetch(`https://${HOST}/`);
    await settle();
    expect(hanging).toHaveBeenCalledOnce();
    await off();
    await expect(waiting).rejects.toBeInstanceOf(PluginInactiveError);
    await expect(held.ctx.net.fetch(`https://${HOST}/`)).rejects.toBeInstanceOf(PluginInactiveError);
    expect(hanging).toHaveBeenCalledOnce();
  });
});

describe('the plugin database facade', () => {
  /** A facade over a fresh archive, with the switch in `on`. */
  const facade = () => {
    const raw = tempDb();
    raw.exec('CREATE TABLE p_probe_rows (v TEXT)');
    const on = { value: true };
    return { raw, on, db: pluginDb(() => raw, () => on.value, 'probe') };
  };
  const count = (raw: ReturnType<typeof tempDb>): number => raw.prepare('SELECT COUNT(*) FROM p_probe_rows').pluck().get() as number;

  it('hands out transactions without the raw connection, each variant fenced by the statements it runs', () => {
    const { raw, on, db } = facade();
    const insert = db.prepare('INSERT INTO p_probe_rows (v) VALUES (?)');
    const tx = db.transaction((v: string) => void insert.run(v));
    for (const t of [tx, tx.deferred, tx.immediate, tx.exclusive]) expect('database' in t).toBe(false);
    tx.immediate('a');
    // Its body gets the caller's `this`, never the native transaction and its raw `database`.
    const self = db.transaction(function (this: unknown) {
      return this;
    });
    for (const t of [self, self.deferred, self.immediate, self.exclusive]) expect(t.call({ caller: 1 })).toEqual({ caller: 1 });
    expect(self()).toBeUndefined();
    expect(self.immediate()).not.toHaveProperty('database');
    on.value = false;
    for (const t of [tx, tx.deferred, tx.immediate, tx.exclusive]) expect(() => t('x')).toThrow(PluginInactiveError);
    expect(count(raw)).toBe(1);
  });

  it('fences each step of a writing iterator, so one made while on writes nothing once off', () => {
    const { raw, on, db } = facade();
    const it = db.prepare<[string], string>('INSERT INTO p_probe_rows (v) VALUES (?) RETURNING v').pluck().iterate('a');
    on.value = false;
    expect(() => it.next()).toThrow(PluginInactiveError);
    expect(count(raw)).toBe(0);
    raw.exec("INSERT INTO p_probe_rows (v) VALUES ('r')");
    expect([...db.prepare<[], string>('SELECT v FROM p_probe_rows').pluck().iterate()]).toEqual(['r']);
  });

  it('refuses statements that change the shared connection, however they are introduced, before SQLite prepares them', () => {
    const { raw, db } = facade();
    const refused = [
      'PRAGMA optimize=0x10002',
      '  /* c */ -- c\n pragma foreign_keys=OFF',
      ';PRAGMA foreign_keys=OFF',
      'EXPLAIN PRAGMA foreign_keys=OFF',
      'explain query plan pragma user_version',
      "ATTACH ':memory:' AS side",
      'BEGIN IMMEDIATE',
      'SAVEPOINT s',
      'VACUUM',
    ];
    for (const sql of refused) expect(() => db.prepare(sql)).toThrow(/change the shared connection/);
    expect(raw.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(raw.inTransaction).toBe(false);
    expect(db.prepare('SELECT * FROM pragma_table_info(?)').all('p_probe_rows')).toHaveLength(1);
    expect(raw.prepare("SELECT COUNT(*) FROM sqlite_master WHERE name = 'sqlite_stat1'").pluck().get()).toBe(0);
  });
});

describe('a main resource run', () => {
  it('ends before its disposer runs: its secrets writes, emits, fetches and fences end with it; the next run is its own', async () => {
    let on = false;
    const published: AppEvent[] = [];
    const failed = vi.fn();
    let resource!: ReturnType<typeof whileActive>;
    const ctx = createMainContext(
      probe,
      { states: { active: () => on }, publish: (e: AppEvent) => void published.push(e), pages: rendererPages(tempDir(), null), secrets: SECRET_FILES, diag: () => undefined } as never,
      { serve: () => undefined, on: () => undefined, whileActive: (start) => void (resource = whileActive('fence', () => on, start, failed)), stage: (apply) => apply() },
    );
    const runs: { live: () => boolean; fetched: Promise<unknown>; ended: boolean[] }[] = [];
    let first!: Parameters<Parameters<typeof ctx.whileActive>[0]>[0];
    ctx.whileActive((run) => {
      first ??= run;
      run.secrets.write('key', `run ${runs.length}`);
      run.emit('shown', runs.length);
      const ended: boolean[] = [];
      runs.push({ live: run.live, fetched: outcome(run.net.fetch(`https://${HOST}/`)), ended });
      return () => void ended.push(!run.live());
    });
    on = true;
    resource.sync();
    await settle();
    const held = outcome(first.fence(new Promise<never>(() => undefined)));
    on = false;
    resource.sync();
    await settle();
    on = true;
    resource.sync();
    await settle();

    expect(failed).not.toHaveBeenCalled();
    expect(runs[0]!.ended).toEqual([true]);
    expect(first.signal.aborted).toBe(true);
    expect(await runs[0]!.fetched).toBeInstanceOf(PluginInactiveError);
    expect(await held).toBeInstanceOf(PluginInactiveError);
    expect(() => first.secrets.write('key', 'late')).toThrow(PluginInactiveError);
    expect(() => first.secrets.delete('key')).toThrow(PluginInactiveError);
    expect(first.secrets.read('key')).toBe('run 1');
    first.emit('shown', -1);
    expect(published.map((e) => (e.type === 'plugin-event' ? e.payload : null))).toEqual([0, 1]);
    expect(runs[1]!.live()).toBe(true);
    await resource.stop();
    expect(runs[1]!.ended).toEqual([true]);
    expect(await runs[1]!.fetched).toBeInstanceOf(PluginInactiveError);
  });

  it('ends a run still starting as soon as the plugin turns off, disposes it once started, and starts afresh when on', async () => {
    let on = true;
    const starts: { run: { live(): boolean }; finish: () => void; stopped: string[] }[] = [];
    const resource = whileActive('fence', () => on, (run) => {
      const stopped: string[] = [];
      return new Promise((resolve) => starts.push({ run, stopped, finish: () => resolve((reason) => void stopped.push(reason)) }));
    }, vi.fn());
    resource.sync();
    await settle();
    on = false;
    resource.sync();
    expect(starts[0]!.run.live()).toBe(false);
    on = true;
    resource.sync();
    starts[0]!.finish();
    await settle();
    expect(starts[0]!.stopped).toEqual(['off']);
    expect(starts).toHaveLength(2);
    expect(starts[1]!.run.live()).toBe(true);
    const quitting = resource.stop();
    expect(starts[1]!.run.live()).toBe(false);
    starts[1]!.finish();
    await quitting;
    expect(starts[1]!.stopped).toEqual(['quit']);
  });
});
