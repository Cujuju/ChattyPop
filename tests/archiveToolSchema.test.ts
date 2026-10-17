import { describe, expect, it } from 'vitest';
import { checkArchiveToolSchema } from '../src/core/plugins/archiveToolSchema';

const schema = (properties: Record<string, unknown>) => ({ type: 'object', properties, additionalProperties: false });

describe('archive tool schema subset', () => {
  it('accepts primitives, typed enums, bounded primitive arrays and standard constraints', () => {
    expect(() => checkArchiveToolSchema('read', { ...schema({
      query: { type: 'string', minLength: 1, maxLength: 100, pattern: '^x', description: 'A query.' },
      mode: { type: 'string', enum: ['first', 'last'] },
      count: { type: 'integer', minimum: 1, maximum: 10 },
      score: { type: 'number', exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.1 },
      active: { type: 'boolean', enum: [true] }, empty: { type: 'null', enum: [null] },
      ids: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: 10 },
    }), required: ['query'], title: 'Read' })).not.toThrow();
  });

  it.each(['$ref', '$defs', 'allOf', 'oneOf', 'anyOf', 'not', 'if', 'unknown'])(
    'rejects unsupported %s at the root and inside fields', (key) => {
      expect(() => checkArchiveToolSchema('read', { ...schema({}), [key]: {} })).toThrow(/AI tool read parameters/);
      expect(() => checkArchiveToolSchema('read', schema({ query: { type: 'string', [key]: {} } }))).toThrow(/AI tool read parameters/);
    },
  );

  it.each([
    { type: 'object', properties: {} }, { type: ['string', 'null'] }, { type: 'array' },
    { type: 'array', items: { type: 'array', items: { type: 'string' } } },
    { type: 'string', minLength: -1 }, { type: 'string', minLength: 2, maxLength: 1 },
    { type: 'string', pattern: '[' }, { type: 'string', enum: [1] }, { type: 'string', enum: [] },
    { type: 'integer', minimum: Infinity }, { type: 'number', multipleOf: 0 },
    { type: 'boolean', description: 7 },
  ])('rejects malformed field %j', (field) => {
    expect(() => checkArchiveToolSchema('badtool', schema({ field }))).toThrow(/AI tool badtool parameters/);
  });

  it('rejects undeclared and duplicate required fields and cyclic field schemas', () => {
    for (const required of [['missing'], ['query', 'query'], 'query']) {
      expect(() => checkArchiveToolSchema('read', { ...schema({ query: { type: 'string' } }), required })).toThrow(/required/);
    }
    const cycle: Record<string, unknown> = { type: 'array' };
    cycle['items'] = cycle;
    expect(() => checkArchiveToolSchema('read', schema({ cycle }))).toThrow(/AI tool read parameters/);
  });
});
