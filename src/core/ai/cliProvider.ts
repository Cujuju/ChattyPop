// A provider driven through the owner's signed-in CLI (Claude Code, Codex): available while the CLI is on PATH.
import { errorMessage } from '@shared/errors';
import { sessionModels } from './modelCache';
import { resolveCli } from './resolveCli';
import type { AccountLinkIo, LlmProvider, ProviderAccount, ProviderChoice, ProviderImpl, ProviderReport } from './types';

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
export function signedInCli(cli: CliSpec, provider: LlmProvider, auth?: CliKeyAuth): ProviderImpl & { status(choice: ProviderChoice, refresh: boolean): Promise<ProviderReport> } {
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

/** A CLI-driven provider's account adapters. */
export interface CliAccountsSpec {
  cli: CliSpec;
  provider(account: ProviderAccount): LlmProvider;
  checkApiKey(key: string): Promise<void>;
  signedIn(account: ProviderAccount): Promise<{ signedIn: boolean; who: string | null }>;
  linkAccount(account: ProviderAccount, io: AccountLinkIo): Promise<void>;
  signOut(account: ProviderAccount): Promise<void>;
}

/** Retains one provider and model cache per account; removal and unload dispose retained instances. */
export function cliAccounts(spec: CliAccountsSpec): ProviderImpl {
  interface Held { provider: LlmProvider; models: ReturnType<typeof sessionModels>; identity: string | null; }
  const held = new Map<string, Held>();
  const get = (account: ProviderAccount): Held => {
    let h = held.get(account.id);
    if (!h) {
      const provider = spec.provider(account);
      h = { provider, models: sessionModels(() => provider.listModels()), identity: null };
      held.set(account.id, h);
    }
    return h;
  };
  return {
    create: (_choice, account) => get(account).provider,
    checkApiKey: spec.checkApiKey,
    linkAccount: async (account, io) => { await spec.linkAccount(account, io); const h = held.get(account.id); if (h) h.identity = null; },
    removeAccount: async (account) => {
      held.get(account.id)?.provider.dispose?.();
      held.delete(account.id);
      if (account.auth === 'signIn') await spec.signOut(account);
    },
    dispose: () => { for (const h of held.values()) h.provider.dispose?.(); held.clear(); },
    status: async (_choice, refresh, account) => {
      if (!resolveCli(spec.cli.bin, spec.cli.npm)) return { available: false, detail: `${spec.cli.name} not found on PATH`, models: null };
      const h = get(account);
      let detail = `Uses your ${spec.cli.name} sign-in`;
      let available = true;
      let signedIn: boolean | undefined;
      let identity: string = account.auth;
      if (account.auth === 'apiKey') {
        const key = account.apiKey();
        identity = JSON.stringify([account.auth, key]);
        available = key !== null;
        detail = key ? 'Uses your API key' : 'Add an API key to use this account';
      } else if (account.auth === 'signIn') {
        const status = await spec.signedIn(account);
        signedIn = status.signedIn;
        available = signedIn;
        identity = JSON.stringify([account.auth, signedIn, status.who]);
        detail = signedIn ? (status.who ? `Signed in as ${status.who}` : 'Signed in') : 'Not signed in';
      }
      if (identity !== h.identity) { h.identity = identity; h.models = sessionModels(() => h.provider.listModels()); }
      const authReport = signedIn === undefined ? {} : { signedIn };
      if (!available) return { available, detail, models: null, ...authReport };
      try { return { available, detail, models: await h.models(refresh), ...authReport }; }
      catch (err) { return { available, detail: `${detail}. Listing models failed: ${errorMessage(err)}`, models: null, ...authReport }; }
    },
  };
}
