// Adding a rule opens it in a new editor; edits typed while it was added open there with it, still unsaved.
import { createRequire } from 'node:module';
import { describe, expect, it, vi } from 'vitest';
import type { RuleInput } from '@shared/rules';
import { newRuleInput } from '@shared/ruleSpec';

// Uses Solid's browser runtime so reactive state runs as in a window.
vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const host = vi.hoisted(() => ({ nextId: 1, finish: [] as (() => void)[] }));
vi.mock('@plugin-sdk/renderer/containment', () => ({
  containedRoot: <T>(fn: () => T): T => (createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js')).createRoot(fn),
}));
vi.mock('@plugin-sdk/renderer/settings', () => {
  const { createSignal } = createRequire(import.meta.url)('solid-js/dist/solid.cjs') as typeof import('solid-js');
  return { createSetting: <T>(_key: string, initial: T) => createSignal(initial) };
});
vi.mock('@/api', () => ({
  api: {
    core: {
      rules: async () => [],
      ruleRuns: async () => [],
      /** Each add waits for the test to finish it. */
      createRule: async () => {
        const id = host.nextId++;
        await new Promise<void>((done) => host.finish.push(done));
        return id;
      },
    },
    rules: {},
  },
}));
vi.mock('../src/renderer/src/state/dialogs', () => ({ confirmDialog: async () => true }));
vi.mock('../src/renderer/src/state/events', () => ({ onAppEvent: () => undefined }));
vi.mock('../src/renderer/src/state/managedControls', () => ({ managedControl: () => null }));
vi.mock('../src/renderer/src/state/paged', () => ({ keyedById: undefined }));
vi.mock('../src/renderer/src/state/ui', () => ({ openSettingsAt: () => undefined }));
vi.mock('../src/renderer/src/state/unsavedChanges', () => ({ guardUnsaved: () => undefined }));

// Renderer modules: imported by path so the node type-check doesn't follow them.
const rulesPath = '../src/renderer/src/state/rules';
const rules = (await import(rulesPath)) as {
  createRule(input: RuleInput, edited: () => RuleInput | null): Promise<void>;
  editsWhileAdded(id: number): RuleInput | null;
  openRuleId(): unknown;
};

const named = (name: string): RuleInput => ({ ...newRuleInput(), name });

/** Starts an add whose write the test finishes; resolves when it has opened the new rule. */
async function add(edited: RuleInput | null): Promise<{ id: number }> {
  const id = host.nextId;
  const done = rules.createRule(named('sent'), () => edited);
  await vi.waitFor(() => expect(host.finish.length).toBe(1));
  host.finish.shift()!();
  await done;
  return { id };
}

describe('adding a rule', () => {
  it('opens the new rule with edits typed while it was added, once', async () => {
    const typed = named('typed while adding');
    const { id } = await add(typed);
    expect(rules.openRuleId()).toBe(id);
    expect(rules.editsWhileAdded(id)).toEqual(typed);
    expect(rules.editsWhileAdded(id)).toBeNull();
  });

  it('with no edits since: opens the new rule as stored', async () => {
    const { id } = await add(null);
    expect(rules.openRuleId()).toBe(id);
    expect(rules.editsWhileAdded(id)).toBeNull();
  });
});
