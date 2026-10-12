// A provider driven through the owner's signed-in CLI (Claude Code, Codex): available while the CLI is on PATH.
import { errorMessage } from '@shared/errors';
import { sessionModels } from './modelCache';
import { resolveCli } from './resolveCli';
import type { LlmProvider, ProviderImpl, ProviderReport } from './types';

/** A CLI ChattyPop drives: its command, its npm package (to follow a Windows shim) and its display name. */
export interface CliSpec {
  bin: string;
  npm: string;
  name: string;
}

/** How a CLI provider reads and checks the owner's API key. */
export interface CliKeyAuth {
  /** The stored key now; null = the CLI's own sign-in pays. */
  apiKey(): string | null;
  /** Rejects a key the vendor doesn't accept. */
  check(key: string): Promise<void>;
}

/** Registers a CLI provider, retaining its model list until refresh or a change of payment key. */
export function signedInCli(cli: CliSpec, provider: LlmProvider, auth?: CliKeyAuth): ProviderImpl {
  let models = sessionModels(() => provider.listModels());
  let listedKey: string | null = null;
  return {
    create: () => provider,
    ...(auth ? { checkApiKey: auth.check } : {}),
    status: async (_choice, refresh): Promise<ProviderReport> => {
      if (!resolveCli(cli.bin, cli.npm)) return { available: false, detail: `${cli.name} not found on PATH`, models: null };
      const key = auth?.apiKey() ?? null;
      if (key !== listedKey) {
        listedKey = key;
        models = sessionModels(() => provider.listModels());
      }
      try {
        return { available: true, detail: key ? 'Uses your API key' : `Uses your ${cli.name} sign-in`, models: await models(refresh) };
      } catch (err) {
        return { available: true, detail: `Installed, but listing models failed: ${errorMessage(err)}`, models: null };
      }
    },
  };
}
