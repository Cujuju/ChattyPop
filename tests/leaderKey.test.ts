// The leader key: every shortcut is the leader, then one key; never while keys belong to a field or overlay.
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LEADER_KEY,
  escapeBlursField,
  isLeaderKey,
  keyLabel,
  leaderStep,
  normalizeLeaderKey,
  type EscapePress,
  type KeyPress,
  type LeaderContext,
} from '../src/renderer/src/state/leaderRules';

const press = (key: string, held: Partial<Omit<KeyPress, 'key'>> = {}): KeyPress => ({ key, ctrlKey: false, altKey: false, metaKey: false, ...held });
const ctx = (over: Partial<LeaderContext> = {}): LeaderContext => ({ leaderKey: DEFAULT_LEADER_KEY, blocked: false, spacePresses: false, ...over });

/** Runs presses through the rules from disarmed; returns each step and the keys that ran shortcuts. */
function run(keys: KeyPress[], context: LeaderContext = ctx()): { steps: string[]; ran: string[] } {
  let armed = false;
  const steps: string[] = [];
  const ran: string[] = [];
  for (const k of keys) {
    const step = leaderStep(armed, k, context);
    steps.push(step.kind);
    if (step.kind === 'arm') armed = true;
    else if (step.kind !== 'pass') armed = false;
    if (step.kind === 'run') ran.push(step.key);
  }
  return { steps, ran };
}

describe('leader key dispatch', () => {
  it('runs a shortcut only after the leader', () => {
    expect(run([press('a')]).ran).toEqual([]);
    expect(run([press(' '), press('a')])).toEqual({ steps: ['arm', 'run'], ran: ['a'] });
  });

  it('never arms while a text field, window or menu owns the keys', () => {
    expect(run([press(' '), press('a')], ctx({ blocked: true }))).toEqual({ steps: ['pass', 'pass'], ran: [] });
  });

  it('disarms without taking the key when focus moves into a field while armed', () => {
    expect(leaderStep(true, press('a'), ctx({ blocked: true }))).toEqual({ kind: 'disarm', consume: false });
  });

  it('leaves Space to a control the keyboard focused, so it still presses it', () => {
    expect(leaderStep(false, press(' '), ctx({ spacePresses: true }))).toEqual({ kind: 'pass' });
    // Another leader is unaffected: Space-pressed controls only keep Space.
    expect(leaderStep(false, press(','), ctx({ leaderKey: ',', spacePresses: true }))).toEqual({ kind: 'arm' });
  });

  it('ignores the leader with Ctrl, Alt or Win held, and a chord disarms without taking its key', () => {
    expect(leaderStep(false, press(' ', { ctrlKey: true }), ctx())).toEqual({ kind: 'pass' });
    expect(leaderStep(true, press('1', { ctrlKey: true }), ctx())).toEqual({ kind: 'disarm', consume: false });
  });

  it('stays armed through a lone modifier (a shifted symbol) and disarms on Escape', () => {
    expect(run([press(' '), press('Shift'), press('?')]).ran).toEqual(['?']);
    expect(leaderStep(true, press('Escape'), ctx())).toEqual({ kind: 'disarm', consume: true });
  });

  it('respects a changed leader: Space is plain again, the new key arms', () => {
    const comma = ctx({ leaderKey: ',' });
    expect(run([press(' '), press('a')], comma).ran).toEqual([]);
    expect(run([press(','), press('a')], comma).ran).toEqual(['a']);
  });
});

describe('leader key shape', () => {
  it('lets the leader be Space or a symbol, never a letter, digit or named key', () => {
    expect(isLeaderKey(' ')).toBe(true);
    expect(isLeaderKey(',')).toBe(true);
    for (const key of ['a', 'Z', '5', 'Tab', 'Enter']) expect(isLeaderKey(key)).toBe(false);
    expect(normalizeLeaderKey('j')).toBe(DEFAULT_LEADER_KEY);
    expect(normalizeLeaderKey(undefined)).toBe(DEFAULT_LEADER_KEY);
    expect(normalizeLeaderKey(';')).toBe(';');
    expect(keyLabel(' ')).toBe('space');
    expect(keyLabel('Tab')).toBe('tab');
  });
});

describe('Escape in a text field', () => {
  const esc = (over: Partial<EscapePress> = {}): EscapePress => ({ ...press('Escape'), shiftKey: false, defaultPrevented: false, isComposing: false, ...over });
  const inField = { inField: true, escapeOwned: false };

  it('blurs the field when nothing else used the Escape', () => {
    expect(escapeBlursField(esc(), inField)).toBe(true);
  });

  it('leaves an Escape a handler used (a menu closed, a reply or edit cancelled) to that handler', () => {
    expect(escapeBlursField(esc({ defaultPrevented: true }), inField)).toBe(false);
  });

  it('leaves Escape to a window, menu or picker, an IME, a chord, and keys outside fields', () => {
    expect(escapeBlursField(esc(), { inField: true, escapeOwned: true })).toBe(false);
    expect(escapeBlursField(esc({ isComposing: true }), inField)).toBe(false);
    expect(escapeBlursField(esc({ ctrlKey: true }), inField)).toBe(false);
    expect(escapeBlursField(esc({ shiftKey: true }), inField)).toBe(false);
    expect(escapeBlursField(esc(), { inField: false, escapeOwned: false })).toBe(false);
    expect(escapeBlursField({ ...esc(), key: 'a' }, inField)).toBe(false);
  });
});