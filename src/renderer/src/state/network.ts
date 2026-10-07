// Whether this device is on a cellular network: the Network Information API where the browser has it (Chromium, Android),
// else the iPhone app's SHELL_NETWORK_EVENT. Neither → false.
import { createSignal } from 'solid-js';
import { SHELL_NETWORK_EVENT, isShellNetworkDetail } from '@shared/shell';

/** The part of the Network Information API read here; absent from TypeScript's DOM lib and from WebKit. */
type NetworkConnection = EventTarget & { readonly type?: string };
const CELLULAR_TYPE = 'cellular';

const connection = (navigator as Navigator & { connection?: NetworkConnection }).connection;
const connectionCellular = (): boolean => connection?.type === CELLULAR_TYPE;

const [cellular, setCellular] = createSignal(connectionCellular());
connection?.addEventListener('change', () => setCellular(connectionCellular()));
window.addEventListener(SHELL_NETWORK_EVENT, (e) => {
  const detail = (e as CustomEvent<unknown>).detail;
  if (isShellNetworkDetail(detail)) setCellular(detail.cellular);
});

/** True while the device is on a cellular network. Reactive. */
export const onCellular = (): boolean => cellular();
