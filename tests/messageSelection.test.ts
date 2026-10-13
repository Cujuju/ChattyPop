// The Archive's message selection: ticking, ranges and the order actions get.
import { beforeEach, expect, it } from 'vitest';
import type { ArchiveMessage } from '@shared/contract';
import { snowflakeFromMs } from '@shared/discord';
import { clearSelection, isSelected, selectThrough, selectedMessages, selecting, toggleSelected } from '../src/renderer/src/state/messageSelection';

const T0 = Date.UTC(2026, 8, 1);
const loaded = Array.from({ length: 6 }, (_, i) => ({ id: snowflakeFromMs(T0 + i), content: `m${i}` }) as ArchiveMessage);
const texts = (): string[] => selectedMessages().map((m) => m.content);

beforeEach(clearSelection);

it('ticks and unticks a message; unticking the last one leaves selection', () => {
  expect(selecting()).toBe(false);
  toggleSelected(loaded[2]!);
  expect(selecting()).toBe(true);
  expect(isSelected(loaded[2]!.id)).toBe(true);
  toggleSelected(loaded[2]!);
  expect(selecting()).toBe(false);
});

it('gives actions the messages oldest first, whatever order they were ticked in', () => {
  [4, 0, 2].forEach((i) => toggleSelected(loaded[i]!));
  expect(texts()).toEqual(['m0', 'm2', 'm4']);
});

it('ticks every loaded message from the last ticked one to the clicked one, in either direction', () => {
  toggleSelected(loaded[3]!);
  selectThrough(loaded[1]!, loaded);
  expect(texts()).toEqual(['m1', 'm2', 'm3']);
  selectThrough(loaded[5]!, loaded);
  expect(texts()).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
});

it('ticks the clicked message alone when the last ticked one is no longer loaded', () => {
  toggleSelected(loaded[0]!);
  selectThrough(loaded[4]!, loaded.slice(2));
  expect(texts()).toEqual(['m0', 'm4']);
});
