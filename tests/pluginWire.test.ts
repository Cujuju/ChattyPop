// The phone transport's shared codec and phone-callable writes (docs/plugin-architecture.md §5): bytes and undefined
// round-trip explicitly; a core call the phone may make states `writes`, and a writing one's decoder runs before its handler.
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { decodeWire, defineChannels, definePlugin, encodeWire, type PluginDescriptor } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import { checkBundled } from '@shared/bundledCheck';
import { testPlugin } from '@plugin-sdk/core/testing';

/** Bytes past one String.fromCharCode chunk, so chunking is crossed. */
const LARGE_BYTES = 0x8000 * 2 + 3;

describe('the wire codec', () => {
  it('round-trips void and undefined explicitly', () => {
    expect(encodeWire(undefined)).toBe('{"$void":true}');
    expect(decodeWire(encodeWire(undefined))).toBeUndefined();
    // A void call's reply envelope says so on the wire, and reads back as undefined.
    expect(encodeWire({ result: undefined })).toBe('{"result":{"$void":true}}');
    expect((decodeWire(encodeWire({ result: undefined })) as { result?: unknown }).result).toBeUndefined();
    const list = decodeWire(encodeWire([1, undefined, 3])) as unknown[];
    expect(list).toHaveLength(3);
    // Present, not a hole: `every` and `some` visit it.
    expect(1 in list).toBe(true);
    expect(list.every((x) => x !== undefined)).toBe(false);
    expect(Object.hasOwn(decodeWire(encodeWire({ a: undefined })) as object, 'a')).toBe(true);
    // A `__proto__` key stays a key.
    const proto = decodeWire('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.hasOwn(proto, '__proto__')).toBe(true);
    expect(decodeWire(encodeWire({ a: null, b: [null] }))).toEqual({ a: null, b: [null] });
  });

  it('carries bytes, Node Buffers included, as Uint8Array', () => {
    const large = Uint8Array.from({ length: LARGE_BYTES }, (_, i) => i % 256);
    const back = decodeWire(encodeWire({ files: [{ bytes: large }], buffer: Buffer.from('hi') })) as { files: { bytes: Uint8Array }[]; buffer: Uint8Array };
    expect(back.files[0]!.bytes).toBeInstanceOf(Uint8Array);
    expect([...back.files[0]!.bytes]).toEqual([...large]);
    expect(back.buffer).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(back.buffer)).toBe('hi');
  });
});

interface ProbeCalls {
  mark(ids: number[]): number;
  read(): string;
}
const probe = definePlugin({
  manifest: { id: 'wireprobe', name: 'Wire probe', version: '1', description: '' },
  channels: defineChannels<{ core: ProbeCalls }>()({
    core: {
      mark: {
        audiences: ['renderer', 'phone'],
        writes: true,
        decode: ([ids]) => {
          if (!Array.isArray(ids) || !ids.every(Number.isInteger)) throw new Error('Not a list of ids.');
          return [ids as number[]];
        },
      },
      read: { audiences: ['phone'], writes: false },
    },
  }),
});

describe('phone-callable core calls', () => {
  it('run their decoder before the handler, from every origin', async () => {
    const marked = vi.fn((ids: number[]) => ids.length);
    const t = testPlugin(defineCorePlugin(probe, (ctx) => ctx.channels.serve({ mark: marked, read: () => 'ok' })));
    onTestFinished(() => t.dispose());
    // Arguments as a caller may send them, whatever the contract's types say.
    const phone = t.client('phone') as unknown as Record<'mark' | 'read', (...args: unknown[]) => Promise<unknown>>;
    const desktop = t.client('renderer') as unknown as Record<'mark', (...args: unknown[]) => Promise<unknown>>;
    await expect(phone.mark(['1; DROP'])).rejects.toThrow('Not a list of ids.');
    await expect(desktop.mark('x')).rejects.toThrow('Not a list of ids.');
    expect(marked).not.toHaveBeenCalled();
    await expect(phone.mark([1, 2])).resolves.toBe(2);
    await expect(phone.read()).resolves.toBe('ok');
  });

  it('state whether they write, and a writing one has a decoder (checkBundled)', () => {
    const declare = (member: unknown, section = 'core'): PluginDescriptor[] => [{ manifest: probe.manifest, channels: { audiences: { [section]: { m: member } } } } as PluginDescriptor];
    expect(() => checkBundled(declare(['renderer', 'phone']))).toThrow(/states writes/);
    expect(() => checkBundled(declare({ audiences: ['phone'] }))).toThrow(/states writes/);
    expect(() => checkBundled(declare({ audiences: ['phone'], writes: true }))).toThrow(/needs a decoder/);
    expect(() => checkBundled(declare({ audiences: ['phone'], writes: true, decode: 'no' }))).toThrow(/decode must be a function/);
    expect(() => checkBundled(declare({ audiences: ['renderer'], writes: false }, 'events'))).toThrow(/only core members take options/);
    expect(() => checkBundled(declare({ audiences: ['phone'], writes: true, decode: (a: unknown[]) => a }))).not.toThrow();
    expect(() => checkBundled(declare({ audiences: ['phone'], writes: false }))).not.toThrow();
    // Desktop-only calls keep the plain form.
    expect(() => checkBundled(declare(['renderer']))).not.toThrow();
    expect(() => checkBundled([probe])).not.toThrow();
  });
});
