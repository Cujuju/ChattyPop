// Shared argument, scope and local-time contracts for archive tools.
import { ARCHIVE_TOOL_LINES_MAX, type ArchiveToolLine, type ArchiveToolResult, type ArchiveToolScope } from './archiveTools';

export interface ToolField {
  type: 'string' | 'integer' | 'number' | 'boolean' | 'null' | 'array';
  description?: string;
  minimum?: number;
  maximum?: number;
  enum?: readonly (string | number | boolean | null)[];
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  items?: ToolField;
  minItems?: number;
  maxItems?: number;
}
export type ToolFields = Record<string, ToolField>;
const LOCAL_TIME_PATTERN = '^\\d{4}-\\d{2}-\\d{2}( \\d{2}:\\d{2})?$';
/** ISO-style local date components have at least two digits. */
const DATE_COMPONENT_WIDTH = 2;
/** Local tool dates use four-digit years. */
const YEAR_WIDTH = 4;
const pad = (value: number): string => String(value).padStart(DATE_COMPONENT_WIDTH, '0');

export const toolTimeFields: ToolFields = {
  since: { type: 'string', pattern: LOCAL_TIME_PATTERN, description: 'Inclusive YYYY-MM-DD or YYYY-MM-DD HH:mm in the owner’s local time. Date-only starts that day; cannot widen the chat window.' },
  until: { type: 'string', pattern: LOCAL_TIME_PATTERN, description: 'Inclusive YYYY-MM-DD or YYYY-MM-DD HH:mm in the owner’s local time. Date-only ends that day; cannot widen the chat window.' },
};
export const toolTextField: ToolField = { type: 'string', minLength: 1 };
export const toolLimitField = (maximum: number): ToolField => ({ type: 'integer', minimum: 1, maximum });
export const toolSchema = (properties: ToolFields, required: string[] = []): Record<string, unknown> =>
  ({ type: 'object', properties, additionalProperties: false, ...(required.length ? { required } : {}) });

function validValue(value: unknown, field: ToolField): boolean {
  if (field.enum && !field.enum.includes(value as string | number | boolean | null)) return false;
  switch (field.type) {
    case 'integer': case 'number': return typeof value === 'number' && Number.isFinite(value)
      && (field.type !== 'integer' || Number.isSafeInteger(value))
      && (field.minimum === undefined || value >= field.minimum) && (field.maximum === undefined || value <= field.maximum);
    case 'boolean': return typeof value === 'boolean';
    case 'null': return value === null;
    case 'array': return Array.isArray(value) && !!field.items && value.every((item) => validValue(item, field.items!))
      && (field.minItems === undefined || value.length >= field.minItems) && (field.maxItems === undefined || value.length <= field.maxItems);
    case 'string': return typeof value === 'string' && value.trim().length >= (field.minLength ?? 0)
      && (field.maxLength === undefined || value.length <= field.maxLength) && (!field.pattern || new RegExp(field.pattern).test(value));
  }
}

/** Rejects unknown fields and invalid values even when the caller bypasses model schema validation. */
export function parseToolArgs<T>(raw: unknown, fields: ToolFields, required: string[] = []): T {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Tool arguments must be an object.');
  if (Object.getPrototypeOf(raw) !== Object.prototype && Object.getPrototypeOf(raw) !== null) throw new Error('Tool arguments must be a plain object.');
  const values = raw as Record<string, unknown>;
  for (const key of required) if (!Object.hasOwn(values, key)) throw new Error(`Missing argument: ${key}.`);
  for (const [key, value] of Object.entries(values)) {
    const field = Object.hasOwn(fields, key) ? fields[key] : undefined;
    if (!field) throw new Error(`Unknown argument: ${key}.`);
    if (!validValue(value, field)) throw new Error(`Invalid argument: ${key}.`);
  }
  return values as T;
}

/** Date-only bounds cover the local day; explicit times reject nonexistent daylight-saving times. */
export function parseToolTime(value: unknown, bound: 'since' | 'until' = 'since'): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !new RegExp(LOCAL_TIME_PATTERN).test(value)) throw new Error(`Invalid ${bound} date: use YYYY-MM-DD or YYYY-MM-DD HH:mm in local time.`);
  const [date, time] = value.split(' ');
  const [year, month, day] = date!.split('-').map(Number) as [number, number, number];
  const [hour, minute] = time ? time.split(':').map(Number) as [number, number] : [0, 0];
  const result = new Date(0);
  result.setFullYear(year, month - 1, day);
  result.setHours(hour, minute, 0, 0);
  if (result.getFullYear() !== year || result.getMonth() !== month - 1 || result.getDate() !== day
    || (time && (result.getHours() !== hour || result.getMinutes() !== minute))) throw new Error(`Invalid ${bound} local date.`);
  if (!time && bound === 'until') {
    result.setDate(day + 1);
    result.setHours(0, 0, 0, 0);
    return result.getTime() - 1;
  }
  return result.getTime();
}

/** Formats archive timestamps in the same local time used by lookup arguments. */
export function toolTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) throw new RangeError('Invalid tool timestamp.');
  return `${String(d.getFullYear()).padStart(YEAR_WIDTH, '0')}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Disjoint windows become an empty channel scope; arguments never enlarge the caller's window. */
export function clampToolScope(scope: ArchiveToolScope, args: { since?: string; until?: string }): ArchiveToolScope {
  const start = parseToolTime(args.since, 'since');
  const end = parseToolTime(args.until, 'until');
  if (start !== undefined && end !== undefined && start > end) throw new Error('since must be <= until.');
  const since = start === undefined ? scope.since : scope.since === null ? start : Math.max(scope.since, start);
  const until = end === undefined ? scope.until : scope.until === null ? end : Math.min(scope.until, end);
  return { channelIds: since !== null && until !== null && since > until ? [] : scope.channelIds, since, until, ...(scope.reader ? { reader: scope.reader } : {}) };
}

/** Scope predicates use exact channel membership, including threads only when explicitly listed. */
export function toolScopeSql(scope: ArchiveToolScope): { sql: string; params: (string | number)[] } {
  const parts = ['m.channel_id IN (SELECT value FROM json_each(?))'];
  const params: (string | number)[] = [JSON.stringify(scope.channelIds)];
  if (scope.since !== null) { parts.push('m.ts >= ?'); params.push(scope.since); }
  if (scope.until !== null) { parts.push('m.ts <= ?'); params.push(scope.until); }
  return { sql: parts.join(' AND '), params };
}

/** Readers fetch one extra row to report truncation without loading every matching message. */
export function toolResult(lines: ArchiveToolLine[], limit: number = ARCHIVE_TOOL_LINES_MAX, readChannels: readonly string[], more = false): ArchiveToolResult {
  const cap = Math.min(limit, ARCHIVE_TOOL_LINES_MAX);
  return { lines: lines.slice(0, cap), readChannels,
    ...(more || lines.length > cap ? { more: true } : {}) };
}
