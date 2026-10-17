import { TOOL_NAME_PATTERN } from './tools';
import type { CompletionRequest } from './types';

/** Validates tool requests; a budget without tools has no effect. */
export function checkToolRequest(req: CompletionRequest): CompletionRequest {
  if (!req.tools) {
    const { maxToolCalls: _ignored, ...plain } = req;
    return plain;
  }
  if (req.schema !== undefined) throw new TypeError('Tools cannot be combined with schema.');
  if (!Number.isSafeInteger(req.maxToolCalls) || req.maxToolCalls! <= 0) {
    throw new TypeError('maxToolCalls must be a positive safe integer with tools.');
  }
  const names = new Set<string>();
  for (const { name } of req.tools) {
    if (typeof name !== 'string' || TOOL_NAME_PATTERN.exec(name)?.[0] !== name) throw new TypeError(`Invalid tool name: ${name}.`);
    if (names.has(name)) throw new TypeError(`Duplicate tool name: ${name}.`);
    names.add(name);
  }
  return req;
}
