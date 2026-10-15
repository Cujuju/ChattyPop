// Leaving a rule's editor with unsaved edits asks once; answering Discard drops the edits, also from an editor that stays
// mounted (Settings closed over it), so it isn't dirty after and asks nothing on the next leave.
import { createRequire } from 'node:module';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const solid = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
// Uses Solid's browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const env = vi.hoisted(() => ({ answer: true, asked: 0 }));
vi.mock('@plugin-sdk/renderer/containment', () => ({
  containedRoot: <T>(fn: () => T): T => (createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js')).createRoot(fn),
}));
vi.mock('@plugin-sdk/renderer/settings', () => {
  const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  return { createSetting: <T>(_key: string, initial: T) => createSignal(initial) };
});
vi.mock('@/api', () => ({ api: { core: { rules: async () => [], ruleRuns: async () => [] }, rules: {} } }));
vi.mock('../src/renderer/src/state/dialogs', () => ({
  confirmDialog: async () => {
    env.asked++;
    return env.answer;
  },
}));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));
vi.mock('../src/renderer/src/state/managedControls', () => ({ managedControl: () => null }));
vi.mock('../src/renderer/src/state/paged', () => ({ keyedById: undefined }));
vi.mock('../src/renderer/src/state/ui', () => ({ openSettingsAt: () => undefined }));
vi.mock('../src/renderer/src/state/unsavedChanges', () => ({ guardUnsaved: () => undefined }));

// A renderer module: imported by path so the node type-check doesn't follow it.
const rulesPath = '../src/renderer/src/state/rules';
const rules = (await import(rulesPath)) as {
  guardRulePage(dirty: () => boolean, discard: () => void): void;
  mayLeaveRulePage(): Promise<boolean>;
};

/** A mounted editor whose draft differs from what's saved. */
function editor() {
  const [draft, setDraft] = solid.createSignal('edited');
  const dispose = solid.createRoot((d) => {
    rules.guardRulePage(() => draft() !== 'saved', () => setDraft('saved'));
    return d;
  });
  return { draft, dispose };
}

describe("leaving a rule's editor", () => {
  beforeEach(() => {
    env.asked = 0;
  });

  it('Discard drops the edits of an editor that stays mounted: the next leave asks nothing', async () => {
    env.answer = true;
    const e = editor();
    expect(await rules.mayLeaveRulePage()).toBe(true);
    expect(e.draft()).toBe('saved');
    expect(await rules.mayLeaveRulePage()).toBe(true);
    expect(env.asked).toBe(1);
    e.dispose();
  });

  it('keeping them leaves the draft as it was', async () => {
    env.answer = false;
    const e = editor();
    expect(await rules.mayLeaveRulePage()).toBe(false);
    expect(e.draft()).toBe('edited');
    e.dispose();
  });
});
