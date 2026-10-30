// Settings → AI → Proxy: the owner's proxy address and client key, and each provider's switch to send through it.
import { Show, createResource, createSignal } from 'solid-js';
import { api } from '@/api';
import { PROXY_NOT_FOR_API_KEYS, PROXY_UNSET, declaredProvider, proxyApplies } from '@shared/aiProviders';
import { normalizeProxyUrl, type ProviderId } from '@shared/settings';
import { aiSettings, patchAiSettings, providerName, providerSettingsOf, refetchProviderStatus, updateProvider } from '@/state/preferences';
import { Switch } from '@/ui/Switch';
import { StoredKeyRow } from './StoredKeyRow';
import { ErrorNote, Row, settingsControl as c } from './SettingsLayout';

const PROXY_URL_FIELD = 'ai-proxy-url';
const BAD_PROXY_URL = 'Enter an http or https address, like http://127.0.0.1:8317.';

/** Whether any provider this build declares can use the proxy, so Settings → AI lists the Proxy section. */
export const proxyDeclared = (providers: readonly { proxy?: boolean }[]): boolean => providers.some((d) => d.proxy);

/** A provider card's proxy row: its switch, or why an API-key account connects directly. */
export function ProxyRow(props: { provider: ProviderId }) {
  const on = () => providerSettingsOf(props.provider).proxy;
  const hint = (): string => {
    if (!on()) return `Requests go straight to ${providerName(props.provider)}.`;
    const url = aiSettings().proxy.url;
    return url ? `Requests go through ${url}.` : PROXY_UNSET;
  };
  return (
    <Show when={declaredProvider(props.provider)?.proxy}>
      <Show when={proxyApplies(props.provider, aiSettings())} fallback={<Row label="Proxy" hint={PROXY_NOT_FOR_API_KEYS} />}>
        <Row label="Send through proxy" hint={hint()} control={
          <Switch label={`Send ${providerName(props.provider)} through the proxy`} checked={on()} onChange={(v) => { updateProvider(props.provider, { proxy: v }); void refetchProviderStatus(); }} />
        } />
      </Show>
    </Show>
  );
}

/** The Proxy section: where switched providers send requests, and the key the proxy accepts from them. */
export function ProxySettings() {
  const [error, setError] = createSignal<string | null>(null);
  const [keyHint, { refetch }] = createResource(() => api.core.aiProxyKeyHint());
  const saveUrl = (text: string): void => {
    const url = normalizeProxyUrl(text);
    if (text.trim() && !url) return void setError(BAD_PROXY_URL);
    setError(null);
    void patchAiSettings({ proxy: { url } }).then(() => refetchProviderStatus());
  };
  return (
    <>
      <Row label="Address" for={PROXY_URL_FIELD} hint="Providers switched to the proxy send every request here, never straight to their vendor." control={
        <input id={PROXY_URL_FIELD} class={c.select} type="url" autocomplete="off" placeholder="http://127.0.0.1:8317"
          value={aiSettings().proxy.url ?? ''} onChange={(e) => saveUrl(e.currentTarget.value)} />
      }><ErrorNote error={error()} /></Row>
      <StoredKeyRow label="Client key" fieldId="ai-proxy-key" placeholder="" hint={keyHint() ?? null}
        emptyHint="Optional: the key your proxy accepts from its clients."
        onSave={async (key) => { await api.providerKeys.setProxyKey(key); await refetch(); }}
        onRemove={async () => { await api.providerKeys.removeProxyKey(); await refetch(); }}
        removeMessage="Remove the proxy client key from ChattyPop?" />
    </>
  );
}
