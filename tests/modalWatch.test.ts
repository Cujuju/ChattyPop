import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { watchModals } = await import('../src/main/discord/modalWatch');

/** A Discord page: its debugger (CDP) and document events. */
function fakePage() {
  const debuggerEvents = new EventEmitter();
  const page = new EventEmitter();
  const commands: { method: string; params: unknown }[] = [];
  const scripts: string[] = [];
  const wc = {
    debugger: Object.assign(debuggerEvents, {
      sendCommand: async (method: string, params: unknown) => void commands.push({ method, params }),
    }),
    executeJavaScript: async (code: string) => void scripts.push(code),
    on: page.on.bind(page),
  };
  const call = (name: string, payload: string): void => void debuggerEvents.emit('message', {}, 'Runtime.bindingCalled', { name, payload });
  return { wc: wc as unknown as Parameters<typeof watchModals>[0], commands, scripts, call, domReady: () => page.emit('dom-ready') };
}

describe('Discord modal watch', () => {
  it('reports the page binding: open, then closed', () => {
    const p = fakePage();
    const seen: boolean[] = [];
    watchModals(p.wc, (open) => seen.push(open));
    const name = (p.commands[0]?.params as { name: string }).name;
    expect(p.commands[0]?.method).toBe('Runtime.addBinding');
    p.call(name, '1');
    p.call(name, '0');
    expect(seen).toEqual([true, false]);
  });

  it('ignores other bindings and malformed payloads', () => {
    const p = fakePage();
    const seen: boolean[] = [];
    watchModals(p.wc, (open) => seen.push(open));
    const name = (p.commands[0]?.params as { name: string }).name;
    p.call('somethingElse', '1');
    p.call(name, 'true');
    expect(seen).toEqual([]);
  });

  it('a new document starts closed and gets the watcher', () => {
    const p = fakePage();
    const seen: boolean[] = [];
    watchModals(p.wc, (open) => seen.push(open));
    p.domReady();
    expect(seen).toEqual([false]);
    expect(p.scripts[0]).toContain('[aria-modal="true"]');
  });
});
