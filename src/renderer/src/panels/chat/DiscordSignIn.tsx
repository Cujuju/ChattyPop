// A remote desktop's way to sign the server's Discord client in: the server's Discord page, relayed as frames, with
// the owner's pointer and keys sent back (state/discordLogin.ts).
import { Show } from 'solid-js';
import type { RelayButton } from '@shared/discordLogin';
import { loginFrame, relayRunning, sendRelayInput, setSignInDismissed, startRelay, stopRelay } from '@/state/discordLogin';

/** DOM pointer buttons as CDP names them. */
const BUTTONS: Record<number, RelayButton> = { 0: 'left', 1: 'middle', 2: 'right' };

export function DiscordSignIn() {
  let img: HTMLImageElement | undefined;
  /** A point on the shown frame in the server page's CSS px. */
  const at = (e: MouseEvent): { x: number; y: number } => {
    const frame = loginFrame();
    const scale = frame && img?.clientWidth ? frame.width / img.clientWidth : 1;
    return { x: Math.round(e.offsetX * scale), y: Math.round(e.offsetY * scale) };
  };
  const pointer = (type: 'mousePressed' | 'mouseReleased' | 'mouseMoved') => (e: PointerEvent) => {
    // Moves count only while a button is down (a drag, a selection), so hovering sends nothing.
    if (type === 'mouseMoved' && e.buttons === 0) return;
    e.preventDefault();
    sendRelayInput({ kind: 'mouse', type, ...at(e), button: type === 'mouseMoved' ? 'left' : (BUTTONS[e.button] ?? 'none'), clickCount: type === 'mouseMoved' ? 0 : Math.max(e.detail, 1) });
  };
  const key = (type: 'keyDown' | 'keyUp') => (e: KeyboardEvent) => {
    e.preventDefault();
    // A printable key without a shortcut modifier types its character; Enter types a return.
    const printable = e.key.length === 1 && !e.ctrlKey && !e.metaKey;
    const text = type === 'keyDown' ? (printable ? e.key : e.key === 'Enter' ? '\r' : null) : null;
    sendRelayInput({ kind: 'key', type, key: e.key, code: e.code, text, keyCode: e.keyCode });
  };

  return (
    <section aria-label="Sign in to Discord on the server">
      <Show
        when={relayRunning()}
        fallback={
          <>
            <p>Discord isn’t signed in on the server, so nothing new is archived. Sign in here: the server’s Discord page shows in this panel.</p>
            <button type="button" class="cp-button" onClick={() => void startRelay()}>
              Sign in to Discord…
            </button>{' '}
            <button type="button" class="cp-button" onClick={() => setSignInDismissed(true)}>
              Not now
            </button>
          </>
        }
      >
        <p>
          The server’s Discord page. Sign in with your password, or scan its QR code with the Discord app.{' '}
          <button type="button" class="cp-button" onClick={() => void stopRelay()}>
            Stop
          </button>
        </p>
        <Show when={loginFrame()} fallback={<p>Waiting for the server’s page…</p>}>
          {(frame) => (
            // Focusable, so keys typed while it has focus go to the server's page; pasting types the pasted text.
            <div
              tabIndex={0}
              onKeyDown={key('keyDown')}
              onKeyUp={key('keyUp')}
              onPaste={(e) => {
                e.preventDefault();
                const text = e.clipboardData?.getData('text/plain');
                if (text) sendRelayInput({ kind: 'text', text });
              }}
            >
              <img
                ref={img}
                src={`data:image/jpeg;base64,${frame().data}`}
                alt="The server’s Discord sign-in page"
                draggable={false}
                // Structural geometry only: the frame fills the panel's width, keeping its shape.
                style={{ width: '100%', height: 'auto' }}
                onPointerDown={pointer('mousePressed')}
                onPointerUp={pointer('mouseReleased')}
                onPointerMove={pointer('mouseMoved')}
                onContextMenu={(e) => e.preventDefault()}
                onWheel={(e) => {
                  e.preventDefault();
                  sendRelayInput({ kind: 'wheel', ...at(e), deltaX: e.deltaX, deltaY: e.deltaY });
                }}
              />
            </div>
          )}
        </Show>
      </Show>
    </section>
  );
}
