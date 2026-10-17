// Note providers live as long as the activation that registered them: a context kept past its plugin turning off registers nothing.
import { describe, expect, it, onTestFinished } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import { defineCorePlugin } from '@plugin-sdk/core';
import type { CoreContext } from '../src/core/plugins/context';
import { partNotes } from '../src/core/attachmentNotes';
import { startProviders } from './providerHost';

const notesprobe = definePlugin({ manifest: { id: 'notesprobe', name: 'Notes probe', version: '1', description: '' } });
const MESSAGE = { id: 'm1', attachmentIds: ['a1'] };
const note = (text: string) => ({ kind: 'audit', state: 'done' as const, label: 'Audit', text });

/** Notes probe started; `provide` registers its notes in each activation, keeping every context it was handed. */
function start(provide: (ctx: CoreContext, text: string) => void) {
  const contexts: CoreContext[] = [];
  const core = defineCorePlugin(notesprobe, (ctx) => {
    contexts.push(ctx as CoreContext);
    provide(ctx as CoreContext, `activation ${contexts.length}`);
  });
  const { host } = startProviders([core], [notesprobe]);
  onTestFinished(() => host.endActivations());
  return { host, contexts };
}
const parts = (ctx: CoreContext, text: string, reads: string[]) =>
  ctx.archive.notes.provide((ids) => {
    reads.push(text);
    return new Map(ids.map((id) => [id, new Map([['content', note(text)]])]));
  });
const attachments = (ctx: CoreContext, text: string, reads: string[]) =>
  ctx.archive.attachmentNotes.provide((ids) => {
    reads.push(text);
    return new Map(ids.map((id) => [id, note(text)]));
  });

describe.each([
  ['part notes', parts],
  ['attachment notes', attachments],
])('%s registered through a retained context', (_kind, register) => {
  it('after the plugin turned off: never read, nothing shown', async () => {
    const reads: string[] = [];
    const { host, contexts } = start(() => undefined);
    await host.setEnabled('notesprobe', false);
    register(contexts[0]!, 'late note', reads);
    expect(partNotes([MESSAGE]).size).toBe(0);
    expect(reads).toEqual([]);
  });

  it("after it turned on again: the new activation's provider stays, and the old one's unload can't drop it", async () => {
    const reads: string[] = [];
    const { host, contexts } = start((ctx, text) => register(ctx, text, reads));
    await host.setEnabled('notesprobe', false);
    await host.setEnabled('notesprobe', true);
    register(contexts[0]!, 'stale', reads);
    const shown = [...partNotes([MESSAGE]).values()].flatMap((byPart) => [...byPart.values()].flat().map((n) => n.text));
    expect(shown).toEqual(['activation 2']);
    expect(reads).toEqual(['activation 2']);
  });
});
