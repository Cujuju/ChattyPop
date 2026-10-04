// A fixture plugin's rule kinds and managed rule, standing in for a bundled plugin's in host rule-spec tests.
import { BUNDLED_PLUGINS } from '@shared/bundledPlugins';
import type { PluginDescriptor } from '@shared/bundledTypes';
import { AFTER_MESSAGE } from '@plugin-sdk/shared';

/** The managed rule key stored before its owner was a plugin, adopted as the fixture's `aimed`. */
export const LEGACY_AIMED = 'aimed_at_me';
export const AIMED = 'r2kinds.aimed';
/** A non-host trigger on message events. */
export const APPLIED = 'r2kinds.applied';
/** An action whose config needs a picked id. */
export const APPLY = 'r2kinds.apply';
/** An action that posts as the owner, live only. */
export const POST = 'r2kinds.post';

const base = { label: 'Fixture', hint: '', validate() {} };

export const r2Kinds: PluginDescriptor = {
  manifest: { id: 'r2kinds', name: 'Kinds fixture', version: '1', description: '' },
  adopts: { managedRules: { [LEGACY_AIMED]: 'aimed' } },
  managedRules: {
    // The managed rule keeps its one match and no narrowing.
    aimed: (s) => {
      if (s.match.length !== 1 || s.match[0]?.type !== AIMED || s.narrow.length)
        throw new Error('The rule could not be read.');
    },
  },
  rules: {
    triggers: [
      {
        ...base,
        type: APPLIED,
        event: 'message',
        create: () => ({ ids: [1] }),
        validate(c) {
          if (!(c as { ids: number[] }).ids.length) throw new Error('Pick the ids.');
        },
      },
    ],
    match: [{ ...base, type: AIMED, asksJev: false, create: () => null }],
    actions: [
      {
        ...base,
        ...AFTER_MESSAGE,
        type: APPLY,
        create: () => ({ id: null }),
        validate(c) {
          if ((c as { id: number | null }).id === null) throw new Error('Pick the id to apply.');
        },
      },
      { ...base, ...AFTER_MESSAGE, type: POST, actsAsYou: true, liveOnly: true, create: () => ({ text: 'hi' }) },
    ],
  },
};

/** Puts the fixture in this file's registry; returns its removal. */
export function includeR2Kinds(): () => void {
  const list = BUNDLED_PLUGINS as PluginDescriptor[];
  list.push(r2Kinds);
  return () => void list.splice(list.indexOf(r2Kinds), 1);
}
