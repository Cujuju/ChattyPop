import type { AppEvent } from '@shared/contract';
import { keyError } from './keyError';
import type { AccountLinkIo, ProviderAccount, ProviderImpl } from './types';

type LinkEvent = Extract<AppEvent, { type: 'account-link' }>;
interface Session {
  controller: AbortController;
  url: string | null;
  opened: boolean;
  codes: string[];
  receive?: (code: string) => void;
}
export const LINK_CANCELLED = 'Sign-in cancelled.';

/** One sign-in per account; cancelled sessions cannot publish late results. */
export class AccountLinks {
  private readonly sessions = new Map<string, Session>();
  constructor(private readonly emit: (event: LinkEvent) => void) {}

  start(account: ProviderAccount, impl: ProviderImpl): void {
    if (account.auth !== 'signIn' || !impl.linkAccount) throw new Error('This account cannot be signed in.');
    if (this.sessions.has(account.id)) throw new Error('A sign-in is already in progress for this account.');
    const s: Session = { controller: new AbortController(), url: null, opened: false, codes: [] };
    this.sessions.set(account.id, s);
    const event = (state: LinkEvent['state'], error: string | null = null): void =>
      this.emit({ type: 'account-link', id: account.id, state, url: s.url, error, opened: s.opened });
    const aborted = new Promise<never>((_, reject) => s.controller.signal.addEventListener('abort', () => reject(s.controller.signal.reason), { once: true }));
    const io: AccountLinkIo = {
      signal: s.controller.signal,
      open: (url, alreadyOpened = false) => {
        if (s.controller.signal.aborted) return;
        const parsed = new URL(url);
        if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Invalid sign-in URL.');
        s.url = parsed.href;
        s.opened = alreadyOpened;
        event('waiting');
      },
      code: () => {
        if (s.controller.signal.aborted) return Promise.reject(s.controller.signal.reason);
        if (s.receive) return Promise.reject(new Error('Already waiting for a sign-in code.'));
        const code = s.codes.shift();
        return code === undefined ? Promise.race([new Promise<string>((resolve) => { s.receive = resolve; }), aborted]) : Promise.resolve(code);
      },
    };
    event('waiting');
    void Promise.race([Promise.resolve().then(() => impl.linkAccount!(account, io)), aborted]).then(
      () => event('done'),
      (err: unknown) => event('failed', keyError(err, account.apiKey()).message),
    ).finally(() => { if (this.sessions.get(account.id) === s) this.sessions.delete(account.id); s.controller.abort(new Error(LINK_CANCELLED)); });
  }

  submit(id: string, code: string): void {
    if (typeof code !== 'string' || !code.trim() || /[\r\n]/.test(code)) throw new Error('Paste one sign-in code.');
    const s = this.sessions.get(id);
    if (!s || s.controller.signal.aborted) throw new Error('No sign-in is in progress for this account.');
    if (s.receive) { const receive = s.receive; delete s.receive; receive(code.trim()); }
    else s.codes.push(code.trim());
  }

  cancel(id: string): void { this.sessions.get(id)?.controller.abort(new Error(LINK_CANCELLED)); }
}
