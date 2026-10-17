// Activation accepts the JSON Schema subset shared by model tool converters.
import { isObj } from '@shared/normalize';

const META = ['title', 'description'];
const NUMERIC = ['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf'];
const LENGTHS = ['minLength', 'maxLength'];
const ITEMS = ['minItems', 'maxItems'];
const PRIMITIVES = ['string', 'number', 'integer', 'boolean', 'null'];
const object = (value: unknown): value is Record<string, unknown> => isObj(value) && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

/** Errors name the contributing tool before a malformed schema can reach any provider. */
export function checkArchiveToolSchema(name: string, schema: unknown): void {
  const fail = (detail: string): never => { throw new TypeError(`AI tool ${name} parameters: ${detail}.`); };
  const keys = (value: Record<string, unknown>, allowed: string[]): void => {
    for (const key of Object.keys(value)) if (!allowed.includes(key)) fail(`unsupported keyword ${key}`);
    for (const key of META) if (key in value && typeof value[key] !== 'string') fail(`${key} must be text`);
  };
  const counts = (value: Record<string, unknown>, names: string[]): void => {
    for (const key of names) if (key in value && (typeof value[key] !== 'number' || !Number.isSafeInteger(value[key]) || (value[key] as number) < 0)) fail(`${key} must be a nonnegative integer`);
    const [min, max] = names;
    if (min! in value && max! in value && (value[min!] as number) > (value[max!] as number)) fail(`${min} exceeds ${max}`);
  };
  const primitiveValue = (value: unknown, type: unknown): boolean => type === 'null' ? value === null
    : type === 'integer' ? typeof value === 'number' && Number.isSafeInteger(value)
    : typeof value === type && (typeof value !== 'number' || Number.isFinite(value));
  const field = (value: unknown, arrayItem = false): void => {
    if (!object(value)) fail('properties must be field schemas');
    const v = value as Record<string, unknown>;
    const type = v['type'];
    if (type === 'array' && !arrayItem) {
      keys(v, ['type', 'items', ...ITEMS, ...META]);
      counts(v, ITEMS);
      field(v['items'], true);
      return;
    }
    if (typeof type !== 'string' || !PRIMITIVES.includes(type)) fail('fields must be primitives or arrays of primitives');
    keys(v, ['type', 'enum', ...META, ...(type === 'string' ? [...LENGTHS, 'pattern'] : type === 'number' || type === 'integer' ? NUMERIC : [])]);
    if ('enum' in v && (!Array.isArray(v['enum']) || !v['enum'].length || !v['enum'].every((item) => primitiveValue(item, type)))) fail('enum must contain values matching its primitive type');
    if (type === 'string') {
      counts(v, LENGTHS);
      if ('pattern' in v) {
        if (typeof v['pattern'] !== 'string') fail('pattern must be text');
        try { new RegExp(v['pattern'] as string); } catch { fail('invalid pattern'); }
      }
    }
    if (type === 'number' || type === 'integer') {
      for (const key of NUMERIC) if (key in v && (typeof v[key] !== 'number' || !Number.isFinite(v[key]))) fail(`${key} must be finite`);
      if ('multipleOf' in v && (v['multipleOf'] as number) <= 0) fail('multipleOf must be positive');
      if ('minimum' in v && 'maximum' in v && (v['minimum'] as number) > (v['maximum'] as number)) fail('minimum exceeds maximum');
    }
  };
  if (!object(schema) || schema['type'] !== 'object' || !object(schema['properties']) || schema['additionalProperties'] !== false) {
    fail('must be an object schema with properties and additionalProperties: false');
  }
  const root = schema as Record<string, unknown>;
  keys(root, ['type', 'properties', 'required', 'additionalProperties', ...META]);
  const properties = root['properties'] as Record<string, unknown>;
  for (const value of Object.values(properties)) field(value);
  if ('required' in root) {
    const required = root['required'];
    if (!Array.isArray(required) || !required.every((key) => typeof key === 'string' && Object.hasOwn(properties, key)) || new Set(required).size !== required.length) fail('required must name unique properties');
  }
}
