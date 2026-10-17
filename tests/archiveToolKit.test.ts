import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { ARCHIVE_TOOL_LINES_MAX, clampToolScope, parseToolArgs, parseToolTime, toolLimitField, toolResult,
  toolSchema, toolScopeSql, toolTextField, toolTime, toolTimeFields, type ArchiveToolScope } from '@plugin-sdk/core';

const scope: ArchiveToolScope = { channelIds: ['first'], since: null, until: null };

describe('archive tool kit', () => {
  it('builds object schemas and validates required, unknown, primitive, enum and array fields', () => {
    const fields = { text: toolTextField, limit: toolLimitField(10), enabled: { type: 'boolean' as const },
      mode: { type: 'string' as const, enum: ['first', 'last'] },
      ids: { type: 'array' as const, items: toolTextField, minItems: 1, maxItems: 2 } };
    expect(toolSchema(fields, ['text'])).toEqual({ type: 'object', properties: fields, required: ['text'], additionalProperties: false });
    const input = { text: 'hello', limit: 2, enabled: true, mode: 'last', ids: ['first'] };
    expect(parseToolArgs(input, fields, ['text'])).toBe(input);
    for (const bad of [null, [], 'text', new Date(), Object.create({ text: 'inherited' }), {},
      { text: '  ' }, { text: 'hello', unknown: true }, { text: 'hello', limit: 1.5 }, { text: 'hello', limit: 11 },
      { text: 'hello', limit: Infinity }, { text: 'hello', mode: 'other' }, { text: 'hello', enabled: 1 },
      { text: 'hello', ids: [] }, { text: 'hello', ids: ['first', 2] }, JSON.parse('{"text":"hello","__proto__":true}')]) {
      expect(() => parseToolArgs(bad, fields, ['text'])).toThrow();
    }
  });

  it('uses local input and output across a UTC day boundary and inclusive date-only day ends', () => {
    vi.stubEnv('TZ', 'America/Los_Angeles');
    onTestFinished(() => { vi.unstubAllEnvs(); });
    const evening = new Date('2026-10-16T20:15:00');
    expect(evening.toISOString()).toContain('2026-10-17');
    expect(toolTime(evening.getTime())).toBe('2026-10-16 20:15');
    expect(parseToolTime('2026-10-16 20:15')).toBe(evening.getTime());
    expect(parseToolTime('2026-10-16', 'since')).toBe(new Date('2026-10-16T00:00:00').getTime());
    expect(parseToolTime('2026-10-16', 'until')).toBe(new Date('2026-10-16T23:59:59.999').getTime());
    expect(parseToolTime('2026-03-08', 'until')).toBe(new Date('2026-03-08T23:59:59.999').getTime());
    expect(() => parseToolTime('2026-03-08 02:30')).toThrow(/local date/);
  });

  it('rejects invalid calendar dates, malformed times and epoch or offset arguments', () => {
    for (const value of ['2026-02-30', '2026-13-01', '2026-01-01 24:00', '2026-01-01 12:60',
      '2026-01-01T12:00:00Z', '2026-01-01 12:00-07:00', 'yesterday', '', 0, NaN, null]) {
      expect(() => parseToolTime(value)).toThrow();
    }
    expect(parseToolTime('2024-02-29')).toBe(new Date('2024-02-29T00:00:00').getTime());
    expect(parseToolTime(undefined)).toBeUndefined();
    expect(() => parseToolArgs({ since: 0 }, toolTimeFields)).toThrow(/since/);
  });

  it('clamps local dates without widening numeric scopes and makes disjoint ranges empty', () => {
    const since = parseToolTime('2026-10-16')!;
    const until = parseToolTime('2026-10-16', 'until')!;
    const bounded = { ...scope, since, until };
    expect(clampToolScope(bounded, { since: '2000-01-01', until: '2099-01-01' })).toEqual(bounded);
    expect(clampToolScope(scope, { since: '2026-10-16', until: '2026-10-16' })).toEqual(bounded);
    expect(clampToolScope(bounded, { since: '2026-10-17' }).channelIds).toEqual([]);
    expect(clampToolScope(bounded, { until: '2026-10-15' }).channelIds).toEqual([]);
    expect(() => clampToolScope(scope, { since: '2026-10-17', until: '2026-10-16' })).toThrow(/since must be <= until/);
    expect(toolScopeSql(bounded)).toEqual({ sql: 'm.channel_id IN (SELECT value FROM json_each(?)) AND m.ts >= ? AND m.ts <= ?',
      params: ['["first"]', since, until] });
    expect(toolScopeSql(scope).params).toEqual(['["first"]']);
  });

  it('caps results and retains provenance and truncation information', () => {
    const lines = Array.from({ length: ARCHIVE_TOOL_LINES_MAX + 1 }, (_, n) => ({ text: String(n) }));
    expect(toolResult(lines).lines).toHaveLength(ARCHIVE_TOOL_LINES_MAX);
    expect(toolResult(lines, 1, ['first'])).toEqual({ lines: [lines[0]], readChannels: ['first'], note: 'More results not shown.' });
    expect(toolResult([], 1, [], true)).toEqual({ lines: [], readChannels: [], note: 'More results not shown.' });
    expect(toolResult([])).toEqual({ lines: [] });
  });
});
