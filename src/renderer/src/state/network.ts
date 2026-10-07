// Whether this device is on a cellular network: the Network Information API where the browser has it (Chromium, Android),
// else the iPhone app's SHELL_NETWORK_EVENT. Neither → false.
import { createSignal } from 'solid-js';
import { SHELL_NETWORK_EVENT, SHELL_NETWORK_HANDLER, isShellNetworkDetail } from '@shared/shell';

/** The part of the Network Information API read here; absent from TypeScript's DOM lib and from WebKit. */
type NetworkConnection = EventTarget & { readonly type?: string };
/** WKWebView's script message handlers; present only in the iPhone app. */
type WebKitHandlers = { webkit?: { messageHandlers?: Record<string, { postMessage(body: unknown): void } | undefined> } };
const CELLULAR_TYPE = 'cellular';

const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
const connectionCellular = (): boolean => connection?.type === CELLULAR_TYPE;

const [cellular, setCellular] = createSignal(connectionCellular());
connection?.addEventListener('change', () => setCellular(connectionCellular()));
window.addEventListener(SHELL_NETWORK_EVENT, (e) => {
  const detail = (e as CustomEvent<unknown>).detail;
  if (isShellNetworkDetail(detail)) setCellular(detail.cellular);
});
// The app replies with SHELL_NETWORK_EVENT, so a module loaded after the page's load still gets the current state.
(window as Window & WebKitHandlers).webkit?.messageHandlers?.[SHELL_NETWORK_HANDLER]?.postMessage({});

/** True while the device is on a cellular network. Reactive. */
export const onCellular = (): boolean => cellular();
