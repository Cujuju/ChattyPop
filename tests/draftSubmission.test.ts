// An editor's save (a rule, a Jev query) finishing after the owner typed on: the later edits stay, still unsaved.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';

// Uses Solid's browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);
const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');

interface Submission<T> {
  readonly value: T;
  settle(stored: T): boolean;
}
// A renderer module: imported by path so the node type-check doesn't follow it.
const actionPath = '../src/renderer/src/ui/action';
const { submitDraft } = (await import(actionPath)) as { submitDraft<T>(draft: () => T, setDraft: (v: T) => unknown): Submission<T> };

interface Draft {
  name: string;
}

/** An editor as RuleEditor and JevQueryEditor keep one: a draft, the saved baseline, dirty when they differ. */
function editor(text: string) {
  const [draft, setDraft] = createSignal<Draft>({ name: text });
  const [saved, setSaved] = createSignal<Draft>({ name: text });
  const dirty = (): boolean => draft().name !== saved().name;
  /** A save whose write finishes when the test says. */
  const save = () => {
    const sent = submitDraft(draft, setDraft);
    const stored = { name: sent.value.name.trim() };
    return () => {
      setSaved(stored);
      return sent.settle(stored);
    };
  };
  return { draft, setDraft, dirty, save };
}

describe('a save finishing', () => {
  it('after more typing: keeps the newer draft, still unsaved', () => {
    const e = editor('old');
    e.setDraft({ name: 'submitted ' });
    const finish = e.save();
    e.setDraft({ name: 'typed while saving' });
    expect(finish()).toBe(false);
    expect(e.draft().name).toBe('typed while saving');
    expect(e.dirty()).toBe(true);
  });

  it('with no edits since: shows what was stored, clean', () => {
    const e = editor('old');
    e.setDraft({ name: 'submitted ' });
    const finish = e.save();
    expect(finish()).toBe(true);
    expect(e.draft().name).toBe('submitted');
    expect(e.dirty()).toBe(false);
  });
});
