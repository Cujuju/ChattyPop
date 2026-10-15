// A floating window's dialog follows its owner's open state. The native close event, queued after every close, reaches
// the owner only when something else closed the dialog: never for a hide its state made, nor after a reopen.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so effects run as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createRoot, createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface Hooks {
  shown(): void;
  hiding(): void;
  hidden(): void;
  request(): void;
}
interface DialogElement {
  readonly open: boolean;
  show(): void;
  close(): void;
}
// A renderer module: imported by path so the node type-check doesn't follow it.
const syncPath = '../src/renderer/src/ui/dialogSync';
const { syncDialog } = (await import(syncPath)) as { syncDialog(el: () => DialogElement, open: () => boolean, hooks: Hooks): () => void };

/** Lets queued tasks (the native close events) run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r));

/** A dialog that queues its close event as a task, as browsers do, owned by a state with a close request. */
function floating() {
  const [open, setOpen] = createSignal(false);
  const hooks = { shown: vi.fn(), hiding: vi.fn(), hidden: vi.fn(), request: vi.fn() };
  let onClose = (): void => undefined;
  const dialog = {
    open: false,
    show() {
      dialog.open = true;
    },
    close() {
      dialog.open = false;
      setTimeout(() => onClose());
    },
  };
  createRoot(() => {
    onClose = syncDialog(() => dialog, open, hooks);
  });
  return { dialog, hooks, setOpen };
}

describe('a floating window dialog', () => {
  it('a hide its state made asks the owner nothing: one close, one question', async () => {
    const w = floating();
    w.setOpen(true);
    w.setOpen(false);
    await settle();
    expect(w.dialog.open).toBe(false);
    expect(w.hooks.hidden).toHaveBeenCalledOnce();
    expect(w.hooks.request).not.toHaveBeenCalled();
  });

  it('a close event queued before a reopen leaves the reopened window alone', async () => {
    const w = floating();
    w.setOpen(true);
    w.setOpen(false);
    w.setOpen(true);
    await settle();
    expect(w.dialog.open).toBe(true);
    expect(w.hooks.shown).toHaveBeenCalledTimes(2);
    expect(w.hooks.hidden).toHaveBeenCalledOnce();
    expect(w.hooks.request).not.toHaveBeenCalled();
  });

  it('closed by something else (a form in it) while its state says open: asks the owner once', async () => {
    const w = floating();
    w.setOpen(true);
    w.dialog.close();
    await settle();
    expect(w.hooks.hidden).toHaveBeenCalledOnce();
    expect(w.hooks.request).toHaveBeenCalledOnce();
  });
});
