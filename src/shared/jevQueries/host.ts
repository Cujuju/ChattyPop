// The host's own Jev queries, in Settings → Jev → Queries order within each group; plugins' queries are placed among them.
import type { JevQueryDef } from './index';
import { MEANING_QUERIES } from './meaning';
import { MESSAGE_QUERIES } from './messages';
import { TOOL_QUERIES } from './tools';

export const HOST_JEV_QUERIES: readonly JevQueryDef[] = [...MEANING_QUERIES, ...MESSAGE_QUERIES, ...TOOL_QUERIES];
