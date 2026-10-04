// Host kind editor contracts and their summaries and narrowing chips.
import type { Component, JSX } from 'solid-js';
import type { RuleSpec } from '@shared/rules';

/** Reactive editor inputs; cover is a fixed timed range and spec supplies cross-part context. */
export interface KindProps<C = unknown> {
  config: C;
  onChange(config: C): void;
  id: string;
  cover?: string;
  spec?: RuleSpec;
}

/** A kind’s editor and summary, with optional host presentation metadata. */
export interface KindView<C = unknown> {
  label?: () => JSX.Element;
  managedOnly?: boolean;
  /** A window action’s hint replaces the message-based wording. */
  windowHint?: string;
  Editor: Component<KindProps<C>>;
  summary(config: C, cover?: string): string;
}

/** A narrowing view also supplies the removable chips shown by the match step. */
export interface FilterView<C = unknown> extends KindView<C> {
  chips(config: C): string[];
}
