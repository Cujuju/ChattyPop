import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { shell } from 'electron';
import { OPENROUTER_API } from '@shared/openrouter';
import { MS_PER_MIN } from '@shared/units';

const AUTH_URL = 'https://openrouter.ai/auth';
const KEY_EXCHANGE_URL = `${OPENROUTER_API}/auth/keys`;
/** Returns the key's details; 401 for an unknown key. */
const KEY_INFO_URL = `${OPENROUTER_API}/key`;
const KEY_CHECK_TIMEOUT_MS = 10_000;
const UNAUTHORIZED = 401;
/** The user completes sign-in in their browser; give up (and close the listener) after this long. */
const SIGN_IN_TIMEOUT_MS = 5 * MS_PER_MIN;
const VERIFIER_BYTES = 32;
const CALLBACK_PATH = '/openrouter/callback';

const base64url = (b: Buffer): string => b.toString('base64url');

/** Returns the trimmed key; throws when OpenRouter doesn't recognise it. */
export async function checkOpenRouterKey(raw: string): Promise<string> {
  const key = raw.trim();
  if (!key) throw new Error('Paste an OpenRouter API key.');
  const res = await fetch(KEY_INFO_URL, { headers: { authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS) });
  if (!res.ok) throw new Error(res.status === UNAUTHORIZED ? 'OpenRouter rejected that key.' : `OpenRouter key check failed: HTTP ${res.status}`);
  return key;
}

/**
 * OAuth PKCE: opens OpenRouter's sign-in in the system browser, receives the code on a one-shot
 * loopback listener and exchanges it for a user-scoped API key. The caller stores it.
 */
export async function signInToOpenRouter(): Promise<string> {
  const verifier = base64url(randomBytes(VERIFIER_BYTES));
  const challenge = base64url(createHash('sha256').update(verifier).digest());

  const code = await new Promise<string>((resolve, reject) => {
    const server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const got = url.searchParams.get('code');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(got ? '<p>Signed in to OpenRouter. You can close this tab and return to ChattyPop.</p>' : '<p>Sign-in was not completed.</p>');
      clearTimeout(timer);
      server.close();
      if (got) resolve(got);
      else reject(new Error('OpenRouter returned no authorization code.'));
    });
    const timer = setTimeout(() => {
      server.close();
      reject(new Error('OpenRouter sign-in timed out.'));
    }, SIGN_IN_TIMEOUT_MS);
    server.on('error', reject);
    // Loopback only, ephemeral port: nothing else on the network can reach it.
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      const auth = new URL(AUTH_URL);
      auth.searchParams.set('callback_url', `http://localhost:${port}${CALLBACK_PATH}`);
      auth.searchParams.set('code_challenge', challenge);
      auth.searchParams.set('code_challenge_method', 'S256');
      void shell.openExternal(auth.href);
    });
  });

  const res = await fetch(KEY_EXCHANGE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, code_verifier: verifier, code_challenge_method: 'S256' }),
  });
  if (!res.ok) throw new Error(`OpenRouter key exchange failed: HTTP ${res.status}`);
  const { key } = (await res.json()) as { key: string };
  return key;
}
