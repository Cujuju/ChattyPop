// Host file and command action implementations.
import type { CommandConfig, FileConfig } from '@shared/ruleKinds/host';
import { cutText } from '@shared/text';
import type { Db } from '../db';
import type { TextMessage } from '../arrival';
import type { RuleRef } from './kinds';
import type { RangeDeps } from './rangeActions';
import { fileAction } from './fileAction';
import type { RuleKinds } from './kinds';
import { actionRange } from './rangeActions';

/** Message context used by the host file writer. */
export interface FireContext {
  rule: RuleRef;
  m: TextMessage;
  live: boolean;
  runId: number;
}

/** Host services used by host actions. */
export type ActionDeps = RangeDeps;

/** Bound stored plugin replies so one command cannot bloat the database. */
export const RULE_DETAIL_MAX_CHARS = 500;
/** Registers file and command action implementations. */
export function registerHostActions(k: RuleKinds, db: Db, deps: ActionDeps): void {
  k.action<FileConfig>('file', (c, r) => {
    if (r.event.kind !== 'message') throw new Error('Writing a message needs a message event.');
    return fileAction(db, c, { rule: r.rule, m: r.event.m });
  });
  k.action<CommandConfig>('command', async (c, r) => {
    const text = await deps.runPluginCommand(c.pluginId, c.commandId, actionRange(r, c.lookbackMs));
    return {
      outcome: 'done',
      detail: text ? (text.length > RULE_DETAIL_MAX_CHARS ? `${cutText(text, RULE_DETAIL_MAX_CHARS)}…` : text) : null,
    };
  });
}
