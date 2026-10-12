import type { AppEvent } from '@shared/contract';
import { DEFAULT_AI_SETTINGS, type AiSettings } from '@shared/aiSettings';
import { accountKey, accountProvider, REMOVED_ACCOUNT } from '@shared/providerAccounts';
import { accountDir, orphanAccountIds, prepareAccountRemoval, removeAccountDir } from './accountFolders';
import { AccountLinks } from './accountLinks';
import { ProviderUnavailableError, type ProviderAccount, type ProviderImpl } from './types';

interface Owner { impl: ProviderImpl; dataDir: string; }
interface Held { account: ProviderAccount; revoked: AbortController; }

/** Account identities, revocation, sign-in sessions and plugin-owned folder cleanup. */
export class ProviderAccounts {
  private settings: AiSettings = DEFAULT_AI_SETTINGS;
  private readSettings: (() => AiSettings) | null = null;
  private emit: (event: AppEvent) => void = () => undefined;
  private readonly owners = new Map<string, Owner>();
  private readonly held = new Map<string, Held>();
  private readonly removing = new Set<string>();
  private pending: Promise<void> = Promise.resolve();
  readonly links = new AccountLinks((event) => this.emit(event));

  constructor(private readonly readKey: (id: string) => string | null) {}
  bind(settings: () => AiSettings, emit: (event: AppEvent) => void): void { this.readSettings = settings; this.emit = emit; }
  current(): AiSettings { if (this.readSettings) this.apply(this.readSettings()); return this.settings; }

  /** Stored settings name the accounts once bound; a caller's copy counts only before, so a stale one removes nothing. */
  sync(settings: AiSettings): void { this.apply(this.readSettings?.() ?? settings); }

  private apply(settings: AiSettings): void {
    this.settings = settings;
    for (const [id, held] of this.held) {
      if (!accountKey(id) || settings.accounts.some((a) => a.id === id && a.auth === held.account.auth)) continue;
      this.held.delete(id);
      held.revoked.abort(new ProviderUnavailableError(REMOVED_ACCOUNT));
      this.links.cancel(id);
      const owner = this.owners.get(accountProvider(id));
      if (owner) {
        this.removing.add(id);
        this.queue(async () => { try { await this.remove(owner, held.account); } finally { this.removing.delete(id); } });
      }
    }
  }

  activate(id: string, impl: ProviderImpl, dataDir: string): void {
    const owner = { impl, dataDir };
    this.owners.set(id, owner);
    this.current();
    for (const a of this.settings.accounts.filter((a) => accountProvider(a.id) === id)) this.get(a.id);
    this.queue(async () => {
      // Unbound, nothing says which folders are kept.
      if (!this.readSettings || this.owners.get(id) !== owner) return;
      const kept = this.current().accounts.map((a) => a.id);
      for (const orphan of await orphanAccountIds(dataDir, id, kept)) {
        if (this.owners.get(id) !== owner) return;
        if (this.removing.has(orphan) || this.current().accounts.some((a) => a.id === orphan)) continue;
        await this.remove(owner, { id: orphan, auth: 'signIn', apiKey: () => null, dir: accountDir(dataDir, orphan) });
      }
    });
  }

  deactivate(id: string): void {
    this.owners.delete(id);
    for (const [key, held] of this.held) {
      if (accountProvider(key) !== id) continue;
      this.links.cancel(key);
      held.revoked.abort(new ProviderUnavailableError('Provider plugin was turned off.'));
      this.held.delete(key);
    }
  }

  get(id: string): Held {
    this.current();
    const key = accountKey(id);
    const stored = key ? this.settings.accounts.find((a) => a.id === id) : null;
    if (key && !stored) throw new ProviderUnavailableError(REMOVED_ACCOUNT);
    const existing = this.held.get(id);
    if (existing) return existing;
    const owner = this.owners.get(accountProvider(id));
    const account: ProviderAccount = {
      id, auth: stored?.auth ?? 'cli', apiKey: () => this.readKey(id),
      dir: stored?.auth === 'signIn' && owner ? accountDir(owner.dataDir, id) : null,
    };
    const held = { account, revoked: new AbortController() };
    this.held.set(id, held);
    return held;
  }

  settled(): Promise<void> { return this.pending; }
  private queue(job: () => Promise<void>): void {
    this.pending = this.pending.then(job).catch((err: unknown) => { console.warn('Account folder cleanup failed:', err); });
  }
  private async remove(owner: Owner, account: ProviderAccount): Promise<void> {
    await prepareAccountRemoval(owner.dataDir, account.id);
    await owner.impl.removeAccount?.(account);
    await removeAccountDir(owner.dataDir, account.id);
  }
}
