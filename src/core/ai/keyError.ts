import { errorMessage } from '@shared/errors';
import type { LlmProvider } from './types';

/** Removes a credential if a provider's error echoes it. */
export function keyError(err: unknown, key: string | null): Error {
  const message = errorMessage(err);
  if (!key || !message.includes(key)) return err instanceof Error ? err : new Error(message);
  return new Error(key ? message.replaceAll(key, '[API key]') : message);
}

/** Provider errors are safe to carry across process boundaries, including a request started before a key change. */
export function keyedProvider(provider: LlmProvider, readKey: () => string | null): LlmProvider {
  const run = async <T>(job: () => Promise<T>): Promise<T> => {
    const key = readKey();
    try { return await job(); } catch (err) { throw keyError(err, key); }
  };
  return {
    id: provider.id,
    maxInputChars: provider.maxInputChars,
    complete: (request) => run(() => provider.complete(request)),
    listModels: () => run(() => provider.listModels()),
    ...(provider.planUsage ? { planUsage: () => run(() => provider.planUsage!()) } : {}),
    ...(provider.dispose ? { dispose: () => provider.dispose!() } : {}),
  };
}
