// The client app's page for picking a server: add one by its address, open or forget a saved one. Its look is the
// theme's (global form and button styles); the page holds no state of its own.
import '../theme/index.css';
import { CONNECT_GLOBAL, CONNECT_UNREACHABLE_PARAMS, type ConnectApi } from '@shared/desktopShell';
import { errorMessage } from '@shared/errors';

const connect = (window as unknown as Record<string, ConnectApi>)[CONNECT_GLOBAL]!;
const byId = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const form = byId<HTMLFormElement>('add');
const input = byId<HTMLInputElement>('server');
const error = byId<HTMLParagraphElement>('error');
const saved = byId<HTMLUListElement>('saved');
const none = byId<HTMLParagraphElement>('none');

/** Electron prefixes an invoked call's error with where it came from; the owner needs only why. */
const REMOTE_ERROR_PREFIX = /^Error invoking remote method '[^']+': (?:Error: )?/;

function showError(message: string | null): void {
  error.textContent = message?.replace(REMOTE_ERROR_PREFIX, '') ?? '';
  error.hidden = message === null;
}

function button(label: string, run: () => Promise<unknown>): HTMLButtonElement {
  const b = Object.assign(document.createElement('button'), { type: 'button', className: 'cp-button', textContent: label });
  b.addEventListener('click', () => void run().then(render, (err: unknown) => showError(errorMessage(err))));
  return b;
}

async function render(): Promise<void> {
  const servers = await connect.list();
  none.hidden = servers.length > 0;
  saved.replaceChildren(
    ...servers.map((s) => {
      const item = document.createElement('li');
      item.append(Object.assign(document.createElement('span'), { textContent: s.origin }), ' ', button('Open', () => connect.open(s.origin)), ' ', button('Forget', () => connect.remove(s.origin)));
      return item;
    }),
  );
}

form.addEventListener('submit', (e) => {
  e.preventDefault();
  showError(null);
  void connect
    .add(input.value)
    .then((origin) => connect.open(origin))
    .then(render, (err: unknown) => showError(errorMessage(err)));
});

// Opened because a server didn't load: say which and why, and offer to try it again.
const query = new URLSearchParams(location.search);
const unreachable = query.get(CONNECT_UNREACHABLE_PARAMS.origin);
if (unreachable) {
  byId<HTMLParagraphElement>('unreachable-text').textContent =
    `Can’t reach ${unreachable} (${query.get(CONNECT_UNREACHABLE_PARAMS.reason) ?? 'no answer'}). Check that the server is running and that this computer is on its Tailscale network (or private network).`;
  byId<HTMLElement>('unreachable').hidden = false;
  byId<HTMLButtonElement>('retry').addEventListener('click', () => void connect.open(unreachable).catch((err: unknown) => showError(errorMessage(err))));
}

void render();
