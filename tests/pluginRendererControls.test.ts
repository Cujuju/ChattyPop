// Generic renderer contributions drop their controls and metadata with their owner.
import { describe, expect, it, vi } from 'vitest';
import { definePlugin } from '@plugin-sdk/shared';
import type { Rule } from '@shared/rules';
import { newRuleInput } from '@shared/ruleSpec';
import { ruleSlots } from '../src/renderer/src/plugins/ruleSlots';
import { frameSlots, type NotificationKind } from '../src/renderer/src/plugins/frameSlots';
import { jevFeatureSlots } from '../src/renderer/src/plugins/jevSlots';
import type { RuleTemplate } from '@shared/ruleTemplates';
import { anchorCatalog, catalogNoticeAnchor, catalogSlotAnchor } from '@shared/bundledCheck';
import { declaredItems, placeSlot } from '../src/renderer/src/plugins/slotItems';
import { orderJevQueries } from '@shared/jevQueries';
import { HOST_JEV_QUERIES } from '@shared/jevQueries/host';
import { offeredQueries, shownQuery } from '../src/renderer/src/state/jevCatalog';
import { presentedParts } from '../src/renderer/src/panels/chat/ownedParts';
import type { AttachmentNote, MessageLabel } from '@shared/contract';

const plugin = definePlugin({
  manifest: { id: 'probe', name: 'Probe', version: '1', description: '' },
  jev: { features: [{ key: 'aimedAtMe', label: 'Aimed at me', default: false }] },
  notices: [{ kind: 'alert', before: 'plugin' }],
});
const rule: Rule = {
  ...newRuleInput(),
  id: 1,
  position: 0,
  armedAt: 0,
  createdAt: 0,
  builtin: 'probe.inbox',
  error: null,
  fired: 0,
  lastFiredAt: null,
};

describe('renderer control probes', () => {
  it('routes only owned managed switches, reads locks reactively, and drops activity and feature ownership while off', async () => {
    let on = true;
    let locked = true;
    const setEnabled = vi.fn();
    const control = { feature: 'aimedAtMe' as const, locked: () => locked, setEnabled };
    const slots = ruleSlots(() => [{
      plugin,
      contributions: {
        rules: {
          managedControls: { inbox: control },
          activity: (r) => r.id === 1 ? '3 pending' : null,
        },
      },
    }], () => on);
    expect(slots.control(rule)?.locked()).toBe(true);
    locked = false;
    expect(slots.control(rule)?.locked()).toBe(false);
    await slots.control(rule)?.setEnabled(true);
    expect(setEnabled).toHaveBeenCalledWith(true);
    expect(slots.control({ ...rule, builtin: 'other.inbox' })).toBeUndefined();
    expect(slots.control({ ...rule, builtin: null })).toBeUndefined();
    expect(slots.activity(rule)).toEqual(['3 pending']);
    expect(slots.activity({ ...rule, id: 2 })).toEqual([]);
    expect(slots.features()).toEqual(['probe.aimedAtMe']);
    on = false;
    expect(slots.control(rule)).toBeUndefined();
    expect(slots.activity(rule)).toEqual([]);
    expect(slots.features()).toEqual([]);
  });

  it('places notice kinds around host kinds and drops disabled or absent owners', () => {
    let on = true;
    const host: NotificationKind[] = [
      { id: 'plugin', label: 'Plugins' },
      { id: 'summaries.summary', label: 'Summaries' },
    ];
    const entries = [{
      plugin,
      contributions: { notificationKinds: { alert: { label: 'Probe' } } },
    }];
    const noticeAnchor = catalogNoticeAnchor(anchorCatalog([plugin]));
    const slots = frameSlots(() => entries, () => on, () => undefined, noticeAnchor);
    expect(slots.notificationKinds(host).map((x) => x.id)).toEqual(['probe.alert', 'plugin', 'summaries.summary']);
    on = false;
    expect(slots.notificationKinds(host)).toEqual(host);
    expect(frameSlots(() => [], () => true, () => undefined, noticeAnchor).notificationKinds(host)).toEqual(host);
    // One plugin's kinds read twice: stamped ids collide as two plugins' can't (checkBundled refuses a duplicate id).
    const twice = [...entries, ...entries];
    expect(() => frameSlots(() => twice, () => true, () => undefined, noticeAnchor).notificationKinds(host)).toThrow('Duplicate notice kind');
  });

  it('places a notice kind by an anchor whose plugin this build leaves out, as when that plugin is off', () => {
    const first = definePlugin({ manifest: { id: 'first', name: 'First', version: '1', description: '' }, notices: [{ kind: 'n', before: 'plugin' }] });
    const second = definePlugin({ manifest: { id: 'second', name: 'Second', version: '1', description: '' }, notices: [{ kind: 'n', after: 'first.n' }] });
    const host: NotificationKind[] = [{ id: 'plugin', label: 'Plugins' }];
    const view = (p: typeof first | typeof second) => ({ plugin: p, contributions: { notificationKinds: { n: { label: p.manifest.name } } } });
    const noticeAnchor = catalogNoticeAnchor(anchorCatalog([first, second]));
    const off = frameSlots(() => [view(first), view(second)], (id) => id === 'second', () => undefined, noticeAnchor);
    const leftOut = frameSlots(() => [view(second)], () => true, () => undefined, noticeAnchor);
    expect(off.notificationKinds(host).map((x) => x.id)).toEqual(['second.n', 'plugin']);
    expect(leftOut.notificationKinds(host).map((x) => x.id)).toEqual(['second.n', 'plugin']);
  });

  it('reads Jev wording only for switches an active owner declares, keyed and named as declared', () => {
    const info = { group: 'Tools' as const, hint: 'Cost' };
    const entries = [{ plugin, contributions: { jevFeatures: { aimedAtMe: info, topicMeaning: info } } }];
    expect(jevFeatureSlots(entries, () => true)).toEqual({ 'probe.aimedAtMe': { ...info, label: 'Aimed at me' } });
    expect(jevFeatureSlots(entries, () => false)).toEqual({});
    expect(jevFeatureSlots([], () => true)).toEqual({});
  });

  it('stamps template ids and places them before host anchors and after plugin anchors, through an absent owner', () => {
    const template = (title: string): RuleTemplate => ({ title, flow: ['Match', 'Act'], hint: '', make: () => ({ actions: [] }) });
    const first = {
      plugin: definePlugin({ manifest: { id: 'first', name: 'First', version: '1', description: '' }, slots: { ruleTemplates: [{ id: 'one', before: 'links' }] } }),
      views: { one: template('one') },
    };
    const next = {
      plugin: definePlugin({
        manifest: { id: 'next', name: 'Next', version: '1', description: '' },
        slots: { ruleTemplates: [{ id: 'two', after: 'first.one' }, { id: 'last' }] },
      }),
      views: { two: template('two'), last: template('last') },
    };
    const anchorOf = catalogSlotAnchor(anchorCatalog([first.plugin, next.plugin]));
    const placed = (entries: readonly (typeof first | typeof next)[]) =>
      placeSlot<{ id: string }>('ruleTemplates', [{ id: 'links' }], declaredItems(entries, 'ruleTemplates', (e) => e.views as Record<string, RuleTemplate>), anchorOf).map((t) => t.id);
    expect(placed([first, next])).toEqual(['first.one', 'next.two', 'links', 'next.last']);
    expect(placed([])).toEqual(['links']);
    // first is off or left out: next.two keeps its place before links instead of appending.
    expect(placed([next])).toEqual(['next.two', 'links', 'next.last']);
  });
});

describe('Jev Queries view', () => {
  it("stops showing a selected query's editor once its owner turns off, and shows it again when it is back", () => {
    // Two plugins' queries among the host's, as the catalog lists them.
    const owners = new Map([['first.query', 'first'], ['second.query', 'second']]);
    const pluginQueries = [...owners.keys()].map((id) => ({ ...HOST_JEV_QUERIES[0]!, id }));
    const catalog = orderJevQueries(HOST_JEV_QUERIES, pluginQueries, () => undefined);
    const jevQueryPlugin = (id: string): string | null => owners.get(id) ?? null;
    let off = new Set<string>();
    const offered = () => offeredQueries(catalog, jevQueryPlugin, (id) => !off.has(id));
    for (const [id, owner] of owners) {
      off = new Set();
      expect(shownQuery(offered(), id)?.id).toBe(id);
      off = new Set([owner]);
      expect(offered().some((d) => d.id === id)).toBe(false);
      const shown = shownQuery(offered(), id);
      expect(shown && jevQueryPlugin(shown.id)).not.toBe(owner);
      off = new Set();
      expect(shownQuery(offered(), id)?.id).toBe(id);
    }
  });
});

describe('plugin parts of a message', () => {
  it('drop from an already loaded message once their owner turns off, and return with it', () => {
    const labels: MessageLabel[] = [
      { subject: 'tag:decision', text: 'decision', title: "Jev's label" },
      { subject: 'usertag:1', text: 'salary', title: 'Your tag', pluginId: 'tags', key: '1' },
    ];
    const notes: AttachmentNote[] = [{ pluginId: 'transcription', part: 'attachment:a1', kind: 'transcript', state: 'done', label: 'Transcript', text: 'hello' }];
    let off = new Set(['tags', 'transcription']);
    const presents = (id: string): boolean => !off.has(id);
    expect(presentedParts(labels, presents).map((l) => l.text)).toEqual(['decision']);
    expect(presentedParts(notes, presents)).toEqual([]);
    off = new Set();
    expect(presentedParts(labels, presents)).toEqual(labels);
    expect(presentedParts(notes, presents)).toEqual(notes);
  });
});
