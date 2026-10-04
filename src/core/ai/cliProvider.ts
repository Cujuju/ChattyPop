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

/** Registers `provider` as the CLI's: its sign-in pays, and its model list is kept for the session. */
export function signedInCli(cli: CliSpec, provider: LlmProvider): ProviderImpl {
  const models = sessionModels(() => provider.listModels());
  return {
    create: () => provider,
    status: async (_choice, refresh): Promise<ProviderReport> => {
      if (!resolveCli(cli.bin, cli.npm)) return { available: false, detail: `${cli.name} not found on PATH`, models: null };
      try {
        return { available: true, detail: `Uses your ${cli.name} sign-in`, models: await models(refresh) };
      } catch (err) {
        return { available: true, detail: `Installed, but listing models failed: ${errorMessage(err)}`, models: null };
      }
    },
  };
}
