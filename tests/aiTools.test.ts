import { describe, expect, it, vi } from 'vitest';
import { answerStream, ftsQuery, historyTranscript, ROUND_SEPARATOR, TOOL_CALLS_SPENT, TOOL_NAME_PATTERN, toolRunner } from '../src/core/ai/tools';
import type { ChatTurn, CompletionEvent, CompletionTool } from '../src/core/ai/types';

/** Two calls exercise the transition into an exhausted budget. */
const CALL_BUDGET = 2;
/** The tool name must leave room for the provider's MCP prefix. */
const TOOL_NAME_MAX = 48;
/** The query contract limits the number of distinctive terms. */
const QUERY_WORDS_MAX = 12;
const tool = (run: CompletionTool['run'], name = 'search'): CompletionTool => ({ name, description: 'Search messages.', parameters: { type: 'object' }, run });
const textDeltas = (events: CompletionEvent[]): string[] => events.flatMap((event) => event.type === 'text' ? [event.delta] : []);

describe('tool names', () => {
  it.each(['search', 'read_messages2', 'a'.repeat(TOOL_NAME_MAX)])('accepts %s', (name) => {
    expect(TOOL_NAME_PATTERN.test(name)).toBe(true);
  });
  it.each(['', 'Search', '_search', '2search', 'read-messages', 'read messages', 'café', 'a'.repeat(TOOL_NAME_MAX + 1)])('refuses %s', (name) => {
    expect(TOOL_NAME_PATTERN.test(name)).toBe(false);
  });
});

describe('toolRunner', () => {
  it('emits the call before running and the successful result afterward', async () => {
    const controller = new AbortController();
    const events: CompletionEvent[] = [];
    const args = { query: 'release' };
    const call = { type: 'toolCall', name: 'search', args, callId: 'lookup' };
    const run = vi.fn(async (received, signal) => {
      expect(received).toBe(args);
      expect(signal).toBe(controller.signal);
      expect(events).toEqual([call]);
      return 'Found messages.';
    });
    const runner = toolRunner({ tools: [tool(run)], maxToolCalls: CALL_BUDGET, onEvent: (event) => events.push(event) }, controller.signal);
    expect(runner.spent).toBe(false);
    expect(await runner.call('search', args, 'lookup')).toEqual({ ok: true, text: 'Found messages.' });
    expect(events).toEqual([call, { type: 'toolResult', callId: 'lookup', ok: true }]);
    expect(runner.spent).toBe(false);
    expect(run).toHaveBeenCalledOnce();
  });

  it('reserves the budget before tools settle and reports calls beyond it', async () => {
    const pending = Promise.withResolvers<string>();
    const run = vi.fn(() => pending.promise);
    const events: CompletionEvent[] = [];
    const runner = toolRunner({ tools: [tool(run)], maxToolCalls: CALL_BUDGET, onEvent: (event) => events.push(event) }, new AbortController().signal);
    const calls = Array.from({ length: CALL_BUDGET }, (_, index) => runner.call('search', {}, String(index)));
    expect(runner.spent).toBe(true);
    expect(TOOL_CALLS_SPENT).toBe('No more lookups are allowed for this answer. Answer now from what you have.');
    expect(await runner.call('search', {}, 'excess')).toEqual({ ok: false, text: TOOL_CALLS_SPENT });
    expect(run).toHaveBeenCalledTimes(CALL_BUDGET);
    expect(events).toEqual([
      ...Array.from({ length: CALL_BUDGET }, (_, index) => ({ type: 'toolCall', callId: String(index), name: 'search', args: {} })),
      { type: 'toolCall', callId: 'excess', name: 'search', args: {} },
      { type: 'toolResult', callId: 'excess', ok: false },
    ]);
    pending.resolve('Found.');
    expect(await Promise.all(calls)).toEqual(Array.from({ length: CALL_BUDGET }, () => ({ ok: true, text: 'Found.' })));
    expect(runner.spent).toBe(true);
    expect(await runner.call('search', {}, 'still-excess')).toEqual({ ok: false, text: TOOL_CALLS_SPENT });
    expect(run).toHaveBeenCalledTimes(CALL_BUDGET);
  });

  it('reports unknown names with available tools and counts failures against the budget', async () => {
    const run = vi.fn(async () => 'Found.');
    const events: CompletionEvent[] = [];
    const runner = toolRunner({ tools: [tool(run), tool(run, 'read')], maxToolCalls: CALL_BUDGET, onEvent: (event) => events.push(event) }, new AbortController().signal);
    expect(await runner.call('missing', null, 'unknown')).toEqual({ ok: false, text: 'Unknown tool "missing". Available tools: search, read.' });
    expect(events).toEqual([
      { type: 'toolCall', callId: 'unknown', name: 'missing', args: null },
      { type: 'toolResult', callId: 'unknown', ok: false },
    ]);
    await runner.call('missing', null, 'unknown-again');
    expect(runner.spent).toBe(true);
    expect(await runner.call('search', {}, 'excess')).toEqual({ ok: false, text: TOOL_CALLS_SPENT });
    expect(run).not.toHaveBeenCalled();
  });

  it.each([new Error('Lookup failed.'), 'Lookup failed.'])('returns thrown failures as text: %s', async (error) => {
    const events: CompletionEvent[] = [];
    const runner = toolRunner({ tools: [tool(() => { throw error; })], maxToolCalls: CALL_BUDGET, onEvent: (event) => events.push(event) }, new AbortController().signal);
    expect(await runner.call('search', {}, 'failed')).toEqual({ ok: false, text: 'Lookup failed.' });
    expect(events).toEqual([
      { type: 'toolCall', callId: 'failed', name: 'search', args: {} },
      { type: 'toolResult', callId: 'failed', ok: false },
    ]);
    await runner.call('search', {}, 'failed-again');
    expect(runner.spent).toBe(true);
  });

  it('converts asynchronous rejections without an event callback', async () => {
    const runner = toolRunner({ tools: [tool(async () => { throw new Error('Offline.'); })], maxToolCalls: CALL_BUDGET }, new AbortController().signal);
    expect(await runner.call('search', {}, 'offline')).toEqual({ ok: false, text: 'Offline.' });
  });

  it('is spent without tools or a budget', async () => {
    const runner = toolRunner({}, new AbortController().signal);
    expect(runner.spent).toBe(true);
    expect(await runner.call('search', {}, 'empty')).toEqual({ ok: false, text: TOOL_CALLS_SPENT });
  });

  it('names an empty list when no tools are available', async () => {
    const runner = toolRunner({ maxToolCalls: CALL_BUDGET }, new AbortController().signal);
    expect(await runner.call('search', {}, 'unknown')).toEqual({ ok: false, text: 'Unknown tool "search". Available tools: none.' });
  });

  it('rejects an already aborted signal with its exact reason and emits nothing', async () => {
    const controller = new AbortController();
    const reason = new Error('Stopped.');
    controller.abort(reason);
    const run = vi.fn(async () => 'Found.');
    const onEvent = vi.fn();
    const runner = toolRunner({ tools: [tool(run)], maxToolCalls: CALL_BUDGET, onEvent }, controller.signal);
    await expect(runner.call('search', {}, 'aborted')).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
    expect(onEvent).not.toHaveBeenCalled();
  });

  it.each(['resolve', 'reject'] as const)('rejects promptly on abort and ignores a late tool %s', async (settle) => {
    const controller = new AbortController();
    const started = Promise.withResolvers<void>();
    const pending = Promise.withResolvers<string>();
    const events: CompletionEvent[] = [];
    const runner = toolRunner({ tools: [tool(() => { started.resolve(); return pending.promise; })], maxToolCalls: CALL_BUDGET, onEvent: (event) => events.push(event) }, controller.signal);
    const call = runner.call('search', {}, 'cancel');
    await started.promise;
    const reason = { stopped: true };
    const rejected = expect(call).rejects.toBe(reason);
    controller.abort(reason);
    await rejected;
    if (settle === 'resolve') pending.resolve('Late answer.');
    else pending.reject(new Error('Late failure.'));
    await Promise.resolve();
    expect(events).toEqual([{ type: 'toolCall', callId: 'cancel', name: 'search', args: {} }]);
  });

  it('does not run a tool if the call event aborts the signal', async () => {
    const controller = new AbortController();
    const reason = 'Cancelled by caller.';
    const run = vi.fn(async () => 'Found.');
    const runner = toolRunner({ tools: [tool(run)], maxToolCalls: CALL_BUDGET, onEvent: () => controller.abort(reason) }, controller.signal);
    await expect(runner.call('search', {}, 'cancel')).rejects.toBe(reason);
    expect(run).not.toHaveBeenCalled();
  });
});

describe('answerStream', () => {
  it('joins emitted deltas to its text across rounds and ignores empty deltas', () => {
    const events: CompletionEvent[] = [];
    const stream = answerStream((event) => events.push(event));
    expect(stream.text).toBe('');
    stream.push('');
    stream.endRound();
    stream.push('First');
    stream.push(' round.');
    stream.endRound();
    stream.push('');
    stream.endRound();
    expect(stream.text).toBe('First round.');
    stream.push('Second');
    stream.push(' round.');
    stream.endRound();
    expect(ROUND_SEPARATOR).toBe('\n\n');
    expect(textDeltas(events)).toEqual(['First', ' round.', ROUND_SEPARATOR, 'Second', ' round.']);
    expect(stream.text).toBe(`First round.${ROUND_SEPARATOR}Second round.`);
    expect(textDeltas(events).join('')).toBe(stream.text);
  });

  it('accumulates without an event callback and treats whitespace as non-empty text', () => {
    const stream = answerStream();
    stream.push(' ');
    stream.endRound();
    stream.push('\n');
    expect(stream.text).toBe(` ${ROUND_SEPARATOR}\n`);
  });
});

describe('historyTranscript', () => {
  it('returns the prompt unchanged for absent or empty history', () => {
    const prompt = '  New question?\n';
    expect(historyTranscript(undefined, prompt)).toBe(prompt);
    expect(historyTranscript([], prompt)).toBe(prompt);
  });

  it('labels earlier turns in order, then the new turn, preserving their text', () => {
    const history: readonly ChatTurn[] = [
      { role: 'user', text: ' First question?\nMore detail.' },
      { role: 'assistant', text: 'First answer.' },
      { role: 'user', text: '' },
    ];
    expect(historyTranscript(history, 'Next question?\n')).toBe('Earlier turns:\n\nUser:\n First question?\nMore detail.\n\nAssistant:\nFirst answer.\n\nUser:\n\n\nNew turn:\n\nUser:\nNext question?\n');
  });
});

describe('ftsQuery', () => {
  it.each(['', '?!', 'a an to of is be', "What did you say and tell them about this? It's just how."])(
    'returns null without distinctive words: %s', (text) => {
      expect(ftsQuery(text)).toBeNull();
    },
  );

  it('lowercases, deduplicates and preserves the order of distinctive words', () => {
    expect(ftsQuery('What about Release release DATABASE and release?')).toBe('"release"* OR "database"*');
  });

  it('splits punctuation and quotes prefix terms without accepting FTS operators', () => {
    expect(ftsQuery('"alpha"* OR beta:gamma_delta NEAR(foo)')).toBe('"alpha"* OR "beta"* OR "gamma"* OR "delta"* OR "near"* OR "foo"*');
  });

  it('keeps Unicode letters and numbers while dropping words shorter than three characters', () => {
    expect(ftsQuery('café CAFÉ Über 日本語 123 42 ab abc')).toBe('"café"* OR "über"* OR "日本語"* OR "123"* OR "abc"*');
  });

  it('caps at twelve unique words after filtering', () => {
    const words = ['alpha', 'beta', 'gamma', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda', 'omicron', 'omega'];
    expect(ftsQuery(`what alpha ${words.join(' ')} omega`)).toBe(words.slice(0, QUERY_WORDS_MAX).map((word) => `"${word}"*`).join(' OR '));
  });
});
