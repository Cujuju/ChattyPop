import type { ChatTurn, CompletionRequest, CompletionTool } from './types';

/** 48: Claude prefixes MCP tools with 16 characters under Anthropic's 64-character tool-name limit. */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;
export const ROUND_SEPARATOR = '\n\n';
export const TOOL_CALLS_SPENT: string = 'No more lookups are allowed for this answer. Answer now from what you have.';

export interface ToolOutcome { ok: boolean; text: string }
export interface ToolRunner {
  readonly spent: boolean;
  call(name: string, args: unknown, callId: string): Promise<ToolOutcome>;
}

/** Rejects promptly on cancellation even when the tool ignores its signal. */
function runTool(tool: CompletionTool, args: unknown, signal: AbortSignal): Promise<string> {
  const result = Promise.withResolvers<string>();
  const abort = () => result.reject(signal.reason);
  signal.addEventListener('abort', abort, { once: true });
  Promise.resolve().then(() => {
    signal.throwIfAborted();
    return tool.run(args, signal);
  }).then(result.resolve, result.reject);
  return result.promise.finally(() => signal.removeEventListener('abort', abort));
}

/** Counts attempted calls, including unknown names and failed tools; budget refusals still emit both events. */
export function toolRunner(req: Pick<CompletionRequest, 'tools' | 'maxToolCalls' | 'onEvent'>, signal: AbortSignal): ToolRunner {
  const tools = new Map((req.tools ?? []).map((tool) => [tool.name, tool]));
  const limit = req.maxToolCalls ?? 0;
  let calls = 0;
  return {
    get spent() { return calls >= limit; },
    async call(name, args, callId) {
      signal.throwIfAborted();
      req.onEvent?.({ type: 'toolCall', callId, name, args });
      signal.throwIfAborted();
      let outcome: ToolOutcome;
      if (calls >= limit) {
        outcome = { ok: false, text: TOOL_CALLS_SPENT };
      } else {
        calls++;
        const tool = tools.get(name);
        if (!tool) {
          outcome = { ok: false, text: `Unknown tool "${name}". Available tools: ${[...tools.keys()].join(', ') || 'none'}.` };
        } else {
          try {
            outcome = { ok: true, text: await runTool(tool, args, signal) };
          } catch (error) {
            signal.throwIfAborted();
            outcome = { ok: false, text: error instanceof Error ? error.message : String(error) };
          }
        }
      }
      signal.throwIfAborted();
      req.onEvent?.({ type: 'toolResult', callId, ok: outcome.ok });
      signal.throwIfAborted();
      return outcome;
    },
  };
}

export interface AnswerStream {
  push(delta: string): void;
  endRound(): void;
  readonly text: string;
}

/** Inserts round separators only when a later round contributes non-empty text. */
export function answerStream(onEvent?: CompletionRequest['onEvent']): AnswerStream {
  let text = '';
  let boundary = false;
  const append = (delta: string): void => {
    text += delta;
    onEvent?.({ type: 'text', delta });
  };
  return {
    get text() { return text; },
    push(delta) {
      if (!delta) return;
      if (boundary && text) append(ROUND_SEPARATOR);
      boundary = false;
      append(delta);
    },
    endRound() { boundary = true; },
  };
}

/** Earlier turns: then User:/Assistant: blocks, separated by blank lines; New turn: then User: and the unchanged prompt. */
export function historyTranscript(history: readonly ChatTurn[] | undefined, prompt: string): string {
  if (!history?.length) return prompt;
  const turns = history.map((turn) => `${turn.role === 'user' ? 'User' : 'Assistant'}:\n${turn.text}`).join('\n\n');
  return `Earlier turns:\n\n${turns}\n\nNew turn:\n\nUser:\n${prompt}`;
}

/** Caps query breadth at twelve distinctive words. */
const FTS_WORDS_MAX = 12;
/** Skips short, low-information query words. */
const FTS_WORD_MIN_CHARS = 3;
/** Common question words excluded from full-text queries. */
const FTS_STOPWORDS = new Set(
  'the and for are was were what when where which who whom whose why how did does has have had not but you your our their they them this that these those with from into about any all can could would should will just been being there here then than also its it\'s say said tell know'.split(' '),
);

/** Distinctive words as quoted, prefix-matched FTS5 terms joined by OR; null when none remain. */
export function ftsQuery(text: string): string | null {
  const words = [...new Set(text.toLowerCase().split(/[^\p{L}\p{N}]+/u))]
    .filter((word) => word.length >= FTS_WORD_MIN_CHARS && !FTS_STOPWORDS.has(word))
    .slice(0, FTS_WORDS_MAX);
  return words.length ? words.map((word) => `"${word}"*`).join(' OR ') : null;
}
