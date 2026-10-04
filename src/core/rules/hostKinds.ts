// Host rule-kind registration at core initialization.
import type { AppEvent } from '@shared/contract';
import type { Db } from '../db';
import { RuleActions } from './actions';
import { RuleKinds } from './kinds';
import { registerHostActions, type ActionDeps } from './hostActions';
import { registerHostMatches } from './hostMatches';

/** Registers the host's implementations before any rules compile or messages arrive. */
export function createRuleActions(
  db: Db,
  deps: ActionDeps,
  emit: (e: AppEvent) => void,
  now: () => number = Date.now,
): RuleActions {
  const kinds = new RuleKinds();
  registerHostMatches(kinds);
  registerHostActions(kinds, db, deps);
  return new RuleActions(db, kinds, now);
}
