// Shared naming checks for descriptor tools and completion tools.

/** 48: Claude prefixes MCP tools with 16 characters under Anthropic's 64-character tool-name limit. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
/** Local names leave room for a plugin prefix in the qualified name. */
const LOCAL_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,23}$/;

/** Validates both local and qualified tool names, returning the model-facing name. */
export function archiveToolName(pluginId: string, name: string): string {
  const qualified = `${pluginId}_${name}`;
  if (typeof name !== 'string' || LOCAL_TOOL_NAME_PATTERN.exec(name)?.[0] !== name || TOOL_NAME_PATTERN.exec(qualified)?.[0] !== qualified) {
    throw new TypeError(`Invalid AI tool name ${qualified}: local names must match ${LOCAL_TOOL_NAME_PATTERN} and qualified names ${TOOL_NAME_PATTERN}.`);
  }
  return qualified;
}
