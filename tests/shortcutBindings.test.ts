// Rebindable shortcut keys: declared keys, the owner's overrides, conflict refusal and the dispatcher's lookup.
import { describe, expect, it } from 'vitest';
import { HOST_SHORTCUTS } from '@shared/anchors';
import { DEFAULT_LEADER_KEY } from '../src/renderer/src/state/leaderRules';
import {
  effectiveBindings,
  leaderRefusal,
  normalizeBindingOverrides,
  pluginShortcutId,
  rebindRefusal,
  shadowedBindings,
  shortcutDefs,
  shortcutTarget,
  withBinding,
  type BindingOverrides,
} from '../src/renderer/src/state/shortcutBindings';

const SPACE = DEFAULT_LEADER_KEY;
/** Fixture declarations: a plugin with two keys, another with one. */
const DEFS = shortcutDefs([
  { pluginId: 'cites', key: 'j', hint: 'next/prev source', name: 'next source' },
  { pluginId: 'cites', key: 'k', hint: 'next/prev source', name: 'previous source' },
  { pluginId: 'reel', key: 'l', hint: 'links' },
]);
const keyOf = (id: string, overrides: BindingOverrides = {}, leader = SPACE): string | undefined =>
  effectiveBindings(DEFS, overrides, leader).find((b) => b.id === id)?.key;

describe('shortcut names', () => {
  const nameOf = (id: string): string | undefined => DEFS.find((d) => d.id === id)?.name;

  it('names a shortcut by its hint in sentence case; the status-bar hint stays as declared', () => {
    expect(nameOf('back')).toBe('Previous channel');
    expect(DEFS.find((d) => d.id === 'back')?.hint).toBe('previous channel');
    expect(nameOf(pluginShortcutId('reel', 'l'))).toBe('Links');
  });

  it('takes a declared name over a hint its group shares', () => {
    expect(nameOf(pluginShortcutId('cites', 'j'))).toBe('Next source');
    expect(nameOf(pluginShortcutId('cites', 'k'))).toBe('Previous source');
    expect(DEFS.find((d) => d.id === pluginShortcutId('cites', 'k'))?.hint).toBe('next/prev source');
  });
});

describe('effective bindings', () => {
  it('uses declared keys by default; the switcher follows the leader', () => {
    expect(keyOf('live')).toBe(HOST_SHORTCUTS.live[0]);
    expect(keyOf('back')).toBe('Tab');
    expect(keyOf(pluginShortcutId('reel', 'l'))).toBe('l');
    expect(keyOf('switcher')).toBe(SPACE);
    expect(keyOf('switcher', {}, ',')).toBe(',');
  });

  it('applies overrides by shortcut id, host and plugin alike', () => {
    const overrides = { live: 'w', [pluginShortcutId('cites', 'j')]: 'n', switcher: 'p' };
    expect(keyOf('live', overrides)).toBe('w');
    expect(keyOf(pluginShortcutId('cites', 'j'), overrides)).toBe('n');
    expect(keyOf(pluginShortcutId('cites', 'k'), overrides)).toBe('k');
    expect(keyOf('switcher', overrides)).toBe('p');
  });

  it('ignores an override for a plugin not loaded, and keeps it stored', () => {
    const stored = normalizeBindingOverrides({ [pluginShortcutId('gone', 'g')]: 'q', live: 'w' });
    expect(effectiveBindings(DEFS, stored, SPACE).some((b) => b.id.startsWith('gone.'))).toBe(false);
    expect(stored[pluginShortcutId('gone', 'g')]).toBe('q');
  });

  it('drops stored keys that cannot be shortcuts: lone modifiers, Escape, non-strings', () => {
    expect(normalizeBindingOverrides({ a: 'Shift', b: 'Control', c: 'Escape', d: 7, e: '', f: 'x' })).toEqual({ f: 'x' });
    expect(normalizeBindingOverrides('x')).toEqual({});
  });

  it('stores only keys that differ from the default', () => {
    const live = DEFS.find((d) => d.id === 'live')!;
    const switcher = DEFS.find((d) => d.id === 'switcher')!;
    expect(withBinding({}, live, 'w', SPACE)).toEqual({ live: 'w' });
    expect(withBinding({ live: 'w', other: 'z' }, live, null, SPACE)).toEqual({ other: 'z' });
    expect(withBinding({ live: 'w' }, live, HOST_SHORTCUTS.live[0], SPACE)).toEqual({});
    expect(withBinding({ switcher: 'p' }, switcher, SPACE, SPACE)).toEqual({});
  });
});

describe('conflict refusal', () => {
  const current = (overrides: BindingOverrides = {}, leader = SPACE) => effectiveBindings(DEFS, overrides, leader);

  it('refuses a key another shortcut uses, host or plugin, naming it', () => {
    expect(rebindRefusal('live', '/', current(), SPACE)).toContain('Search');
    expect(rebindRefusal('live', 'l', current(), SPACE)).toContain('Links');
    expect(rebindRefusal('live', 'k', current(), SPACE)).toContain('Previous source');
    expect(rebindRefusal(pluginShortcutId('reel', 'l'), 'a', current(), SPACE)).toContain('Live/archive');
    expect(rebindRefusal('live', 'w', current(), SPACE)).toBeNull();
    // Its own key is no conflict.
    expect(rebindRefusal('live', 'a', current(), SPACE)).toBeNull();
  });

  it('refuses the leader, except for the switcher that follows it', () => {
    expect(rebindRefusal('live', SPACE, current(), SPACE)).toContain('leader');
    expect(rebindRefusal('live', ',', current({}, ','), ',')).toContain('leader');
    expect(rebindRefusal('switcher', SPACE, current({ switcher: 'p' }), SPACE)).toBeNull();
  });

  it('refuses the layout digits, lone modifiers and Escape', () => {
    expect(rebindRefusal('live', '3', current(), SPACE)).not.toBeNull();
    for (const key of ['Shift', 'Control', 'Alt', 'Meta', 'Escape']) expect(rebindRefusal('live', key, current(), SPACE)).not.toBeNull();
  });

  it('refuses a leader a shortcut takes, and frees it once that shortcut moves', () => {
    expect(leaderRefusal('/', current())).toContain('Search');
    expect(leaderRefusal('/', current({ search: '?' }))).toBeNull();
    expect(leaderRefusal(',', current())).toBeNull();
    expect(leaderRefusal('a', current())).not.toBeNull();
    // The switcher follows the leader, so it never blocks one; bound elsewhere, its key does.
    expect(leaderRefusal(SPACE, current())).toBeNull();
    expect(leaderRefusal(',', current({ switcher: ',' }, SPACE))).toContain('Switch channel');
  });

  it('flags a binding an earlier one shadows on the same key', () => {
    // A plugin installed after the owner bound `live` to its key.
    const shadowed = shadowedBindings(current({ live: 'l' }));
    expect(shadowed.get(pluginShortcutId('reel', 'l'))?.id).toBe('live');
    expect(shadowedBindings(current()).size).toBe(0);
  });
});

describe('dispatcher lookup', () => {
  it('runs what a key is bound to, overrides included', () => {
    const overrides = { live: 'w', [pluginShortcutId('cites', 'j')]: 'n' };
    const bound = effectiveBindings(DEFS, overrides, SPACE);
    expect(shortcutTarget('w', bound)).toEqual({ kind: 'host', id: 'live' });
    expect(shortcutTarget('a', bound)).toBeNull();
    // A plugin's action stays under its declared key.
    expect(shortcutTarget('n', bound)).toEqual({ kind: 'plugin', pluginId: 'cites', key: 'j' });
    expect(shortcutTarget('j', bound)).toBeNull();
    expect(shortcutTarget(SPACE, bound)).toEqual({ kind: 'host', id: 'switcher' });
    expect(shortcutTarget('Tab', bound)).toEqual({ kind: 'host', id: 'back' });
  });

  it('keeps the layout digits as a fixed group', () => {
    const bound = effectiveBindings(DEFS, {}, SPACE);
    expect(shortcutTarget('1', bound)).toEqual({ kind: 'layout', index: 0 });
    expect(shortcutTarget('9', bound)).toEqual({ kind: 'layout', index: 8 });
  });
});
