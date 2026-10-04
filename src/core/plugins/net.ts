// A bundled plugin's network access (ctx.net.fetch): HTTPS to the hosts its descriptor lists, and the addresses the
// owner set for it, every redirect hop checked the same way. Discord is never reachable (law 4).
import { canonicalHost, isDiscordHost, pluginSettingKey, type PluginDescriptor } from '@shared/bundledTypes';
import type { OwnerUrl } from '@shared/descriptorParts';
import { isObj } from '@shared/normalize';

/** The Fetch standard's redirect limit. */
const MAX_REDIRECTS = 20;
const SEE_OTHER = 303;
/** Moved Permanently and Found: a POST continues as a GET. */
const POST_BECOMES_GET: ReadonlySet<number> = new Set([301, 302]);
/** Every redirect status; Temporary (307) and Permanent (308) Redirect keep the method and body. */
const REDIRECTS: ReadonlySet<number> = new Set([...POST_BECOMES_GET, SEE_OTHER, 307, 308]);

export type PluginFetch = (url: string, init?: Omit<RequestInit, 'redirect'>) => Promise<Response>;
/** Sends one request hop once the policy allowed it, never following a redirect: the network itself. */
export type NetworkSend = (url: URL, init: RequestInit) => Promise<Response>;
/** The network: the global fetch, read per request. */
const globalSend: NetworkSend = (url, init) => fetch(url, init);

/** A listed host, or a subdomain of one: a CDN's regional hosts share its domain. */
export function hostListed(hosts: readonly string[], hostname: string): boolean {
  const host = canonicalHost(hostname);
  return hosts.some((h) => host === h || host.endsWith(`.${h}`));
}

/** Request headers a redirect to another origin drops, as native fetch does: credentials and the explicit host. */
const CROSS_ORIGIN_DROPPED = ['authorization', 'proxy-authorization', 'cookie', 'host'];
/** Body headers dropped when a redirect turns the request into a GET, as native fetch does. */
const BODY_HEADERS = ['content-type', 'content-encoding', 'content-language', 'content-location'];
const without = (headers: RequestInit['headers'], names: readonly string[]): Headers => {
  const out = new Headers(headers);
  for (const name of names) out.delete(name);
  return out;
};

/** Schemes an owner-set address may use: a server on this PC or the LAN rarely has a certificate. */
const OWNER_URL_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/** The origins of the owner's addresses as saved now; `read` returns a plugin setting. An unparsable address allows nothing. */
export function ownerOrigins(urls: readonly OwnerUrl[], read: (setting: string) => unknown): () => Promise<string[]> {
  return async () => {
    const origins: string[] = [];
    for (const { setting, field, fallback } of urls) {
      const saved = await read(setting);
      const url = isObj(saved) && typeof saved[field] === 'string' ? saved[field] : fallback;
      if (URL.canParse(url)) origins.push(new URL(url).origin);
    }
    return origins;
  };
}

/**
 * A plugin's ctx.net.fetch in any process, from its descriptor: `network.hosts`, and `network.ownerUrls` as saved when
 * each request is sent. `read` returns a setting by its stored key (sync in core, over IPC in main); `send` is the network.
 */
export function descriptorFetch(plugin: PluginDescriptor, read: (settingKey: string) => unknown, send?: NetworkSend): PluginFetch {
  const id = plugin.manifest.id;
  return pluginFetch(id, plugin.network?.hosts ?? [], ownerOrigins(plugin.network?.ownerUrls ?? [], (name) => read(pluginSettingKey(id, name))), send);
}

/**
 * Fetch for plugin `pluginId`, limited to HTTPS to `hosts` and to the origins `owner` returns (read per request).
 * Redirects are followed here, so each hop is checked before `send` (the global fetch by default) sends it.
 */
export function pluginFetch(pluginId: string, hosts: readonly string[], owner: () => Promise<readonly string[]>, send: NetworkSend = globalSend): PluginFetch {
  const listed = (u: URL): boolean => u.protocol === 'https:' && hostListed(hosts, u.hostname);
  const ownerSet = async (u: URL): Promise<boolean> => OWNER_URL_PROTOCOLS.has(u.protocol) && (await owner()).includes(u.origin);
  const check = async (u: URL): Promise<void> => {
    // Discord first, whichever list would allow it (law 4).
    if (isDiscordHost(u.hostname) || (!listed(u) && !(await ownerSet(u))))
      throw new Error(`${pluginId} may not fetch ${u.origin}: not a declared network host or an address set for it`);
  };
  return async (url, init = {}) => {
    let target = new URL(url);
    let request: RequestInit = init;
    for (let hops = 0; ; hops++) {
      await check(target);
      const res = await send(target, { ...request, redirect: 'manual' });
      const location = res.headers.get('location');
      if (!REDIRECTS.has(res.status) || location === null) return res;
      await res.body?.cancel();
      if (hops === MAX_REDIRECTS) throw new Error(`${pluginId}: too many redirects from ${url}`);
      const next = new URL(location, target);
      if (next.origin !== target.origin) request = { ...request, headers: without(request.headers, CROSS_ORIGIN_DROPPED) };
      target = next;
      // As the Fetch standard: See Other continues as a GET (HEAD stays HEAD).
      const method = (request.method ?? 'GET').toUpperCase();
      if (res.status === SEE_OTHER ? method !== 'HEAD' : POST_BECOMES_GET.has(res.status) && method === 'POST')
        request = { ...request, method: 'GET', body: null, headers: without(request.headers, BODY_HEADERS) };
    }
  };
}
