// Per-question lifecycle within a plugin; replacement or disposal makes retained answer callbacks inert.
import { registerMessageQuestion, type MessageQuestion, type QuestionOwner } from '../jev/messageQuestions';
import type { Registrations } from './api';

const scopes = new WeakMap<Registrations, Map<string, () => void>>();

/** Registers a guarded question with a disposer for both its registry entry and in-flight callbacks. */
export function pluginQuestion(
  q: MessageQuestion,
  owner: QuestionOwner,
  reg: Registrations,
  ask: <T>(fn: () => T, fallback: T) => T,
): () => void {
  if (reg.unloaded) return () => undefined;
  const questions = scopes.get(reg) ?? new Map<string, () => void>();
  if (!scopes.has(reg)) {
    scopes.set(reg, questions);
    reg.disposers.push(() => [...questions.values()].forEach((dispose) => dispose()));
  }
  questions.get(q.subject)?.();
  let active = true;
  const call = <T>(fn: () => T, fallback: T): T => active ? ask(fn, fallback) : fallback;
  const unregister = registerMessageQuestion(
    {
      ...q,
      question: (m, c) => call(() => q.question(m, c), null),
      certain: q.certain ? (m) => call(() => q.certain!(m), null) : undefined,
      onAnswer: q.onAnswer ? (m, a, at) => call(() => q.onAnswer!(m, a, at), undefined) : undefined,
      label: q.label ? (stored) => call(() => q.label!(stored), null) : undefined,
    },
    owner,
  );
  const dispose = (): void => {
    active = false;
    unregister();
    if (questions.get(q.subject) === dispose) questions.delete(q.subject);
  };
  questions.set(q.subject, dispose);
  return dispose;
}
