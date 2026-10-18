import { EventEmitter } from 'node:events';
import { createInflate, createZstdDecompress, constants, type Inflate, type ZstdDecompress } from 'node:zlib';
import type { WebContents } from 'electron';
import { diag } from '../diagnostics';

/** Gateway dispatch as the client received it. `t` is the event name, `d` its payload. */
export interface GatewayDispatch {
  /** Passive socket provenance prevents delayed frames from a previous login authorizing a new one. */
  socketId?: string;
  t: string;
  s: number | null;
  d: unknown;
}

export interface GatewayTapStats {
  url: string | null;
  compress: string | null;
  frames: number;
  decodeErrors: number;
  events: Record<string, number>;
}

const CDP_PROTOCOL_VERSION = '1.3';
const GATEWAY_HOST = /gateway[\w.-]*\.discord\.gg/;
const DISPATCH_OP = 0;
/** Gateway op 9: the server rejected the session (token revoked or session invalid). */
const INVALID_SESSION_OP = 9;
/** WebSocket close frame opcode. */
const WS_CLOSE_OPCODE = 8;
/** WebSocket text frame opcode. */
const WS_TEXT_OPCODE = 1;
/** Temporary tap diagnosis: one metadata-only snapshot per minute, never frame content. */
const TAP_DIAGNOSTIC_INTERVAL_MS = 60_000;
/** Bound repeated failure logging while retaining complete counters in snapshots. */
const TAP_DIAGNOSTIC_FAILURES_LOGGED = 3;

type Decoder = { write(chunk: Buffer): Promise<string> };

/** Opened: a gateway socket the tap reads, whose session starts anew. Ended: the tap reads none now (last one closed, or detached). */
export type GatewayChange = 'opened' | 'ended';

/** A frame sent on the gateway socket: its opcode and payload. */
export interface GatewaySend {
  socketId?: string;
  op: number;
  d: unknown;
}

/**
 * Reads the embedded client's own gateway traffic through CDP; sends nothing to Discord. `sent` is a frame the client sent.
 * Network events must be on before the page opens its socket (compressed streams can't be decoded mid-stream): load the
 * client only once `ready` settles. CDP turns them on only when a page process exists, so a blank page must load first.
 */
export class GatewayTap extends EventEmitter<{ dispatch: [GatewayDispatch]; sent: [GatewaySend]; gateway: [GatewayChange] }> {
  readonly stats: GatewayTapStats = { url: null, compress: null, frames: 0, decodeErrors: 0, events: {} };
  /** Settles once Network events are on, or failed to turn on (diagnosed): the client may load then. */
  readonly ready: Promise<void>;
  private readonly decoders = new Map<string, Decoder>();
  private readonly diagnosticStarted = performance.now();
  private readonly diagnosticMethods: Record<string, number> = {};
  private readonly diagnosticOrphans = new Set<string>();
  /** Whether Network events are on; listen() turns them on again unless they are. */
  private network: 'pending' | 'enabled' | 'failed' = 'pending';
  /** Logs the tap's metadata-only state (set in the constructor). */
  private readonly snapshot: (reason: string) => void;
  private diagnosticReceived = 0;
  private diagnosticUntracked = 0;
  private diagnosticSessionMessages = 0;
  private diagnosticPayloads = 0;

  constructor(private readonly wc: WebContents) {
    super();
    wc.debugger.attach(CDP_PROTOCOL_VERSION);
    wc.debugger.on('message', (_e, method, params, sessionId) => {
      this.diagnosticMethods[method] = (this.diagnosticMethods[method] ?? 0) + 1;
      if (sessionId) this.diagnosticSessionMessages++;
      this.onCdp(method, params);
    });
    const snapshot = (reason: string): void => {
      const destroyed = wc.isDestroyed();
      diag('gateway-tap-snapshot', {
        reason, webContentsId: wc.id, elapsedMs: Math.round(performance.now() - this.diagnosticStarted),
        destroyed, attached: !destroyed && wc.debugger.isAttached(),
        rendererPid: destroyed ? null : wc.getOSProcessId(), network: this.network,
        sockets: this.decoders.size, socketObserved: this.stats.url !== null, compress: this.stats.compress,
        rawReceived: this.diagnosticReceived, untrackedReceived: this.diagnosticUntracked,
        sessionMessages: this.diagnosticSessionMessages, payloads: this.diagnosticPayloads,
        frames: this.stats.frames, decodeErrors: this.stats.decodeErrors,
        events: { ...this.stats.events }, methods: { ...this.diagnosticMethods },
      });
    };
    wc.debugger.on('detach', (_e, reason) => {
      diag('gateway-tap-detached', { webContentsId: wc.id, reason });
      snapshot('detach');
      this.network = 'pending';
      if (this.decoders.size === 0) return;
      this.decoders.clear();
      this.emit('gateway', 'ended');
    });
    wc.on('did-start-navigation', (_e, _url, inPlace, mainFrame) => {
      if (mainFrame && !inPlace) snapshot('navigation-start');
    });
    wc.on('did-navigate', () => snapshot('did-navigate'));
    wc.on('dom-ready', () => snapshot('dom-ready'));
    wc.on('did-finish-load', () => snapshot('did-finish-load'));
    wc.on('render-process-gone', (_e, details) => {
      diag('gateway-tap-renderer-gone', { webContentsId: wc.id, reason: details.reason, exitCode: details.exitCode });
      snapshot('renderer-gone');
    });
    const timer = setInterval(() => snapshot('interval'), TAP_DIAGNOSTIC_INTERVAL_MS);
    timer.unref();
    wc.on('destroyed', () => { clearInterval(timer); snapshot('destroyed'); });
    snapshot('attached');
    this.snapshot = snapshot;
    this.ready = this.enable();
  }

  private enable(): Promise<void> {
    const { wc } = this;
    return wc.debugger.sendCommand('Network.enable').then(
      () => { this.network = 'enabled'; this.snapshot('network-enabled'); },
      (error: unknown) => {
        this.network = 'failed';
        diag('gateway-tap-network-failed', { webContentsId: wc.id, message: error instanceof Error ? error.message : String(error) });
        this.snapshot('network-failed');
      },
    );
  }

  /** Attaches again if detached and turns Network events on if they are off; settles as `ready` does. Load the client after. */
  listen(): Promise<void> {
    const { wc } = this;
    if (wc.isDestroyed()) return Promise.resolve();
    if (!wc.debugger.isAttached()) {
      try {
        wc.debugger.attach(CDP_PROTOCOL_VERSION);
      } catch (error) {
        diag('gateway-tap-attach-failed', { webContentsId: wc.id, message: error instanceof Error ? error.message : String(error) });
        return Promise.resolve();
      }
    }
    return this.network === 'enabled' ? Promise.resolve() : this.enable();
  }

  private onCdp(method: string, params: Record<string, unknown>): void {
    if (method === 'Network.webSocketCreated') {
      const url = String(params['url']);
      const socketUrl = new URL(url);
      diag('gateway-tap-socket-created', {
        requestId: params['requestId'], host: socketUrl.hostname,
        gateway: GATEWAY_HOST.test(socketUrl.hostname), compress: socketUrl.searchParams.get('compress'),
        encoding: socketUrl.searchParams.get('encoding'), elapsedMs: Math.round(performance.now() - this.diagnosticStarted),
      });
      if (!GATEWAY_HOST.test(new URL(url).hostname)) return;
      const compress = new URL(url).searchParams.get('compress');
      this.stats.url = url;
      this.stats.compress = compress;
      this.decoders.set(String(params['requestId']), makeDecoder(compress));
      this.emit('gateway', 'opened');
      return;
    }
    if (method === 'Network.webSocketFrameSent') {
      if (this.decoders.has(String(params['requestId']))) this.onSent(params['response'] as { opcode: number; payloadData: string }, String(params['requestId']));
      return;
    }
    if (method === 'Network.webSocketClosed') {
      if (!this.decoders.delete(String(params['requestId']))) return;
      diag('gateway-socket-closed');
      if (this.decoders.size === 0) this.emit('gateway', 'ended');
      return;
    }
    if (method !== 'Network.webSocketFrameReceived') return;
    this.diagnosticReceived++;
    const decoder = this.decoders.get(String(params['requestId']));
    if (!decoder) {
      this.diagnosticUntracked++;
      const requestId = String(params['requestId']);
      if (!this.diagnosticOrphans.has(requestId)) {
        this.diagnosticOrphans.add(requestId);
        diag('gateway-tap-untracked-frame', { requestId, elapsedMs: Math.round(performance.now() - this.diagnosticStarted) });
      }
      return;
    }
    const { opcode, payloadData } = params['response'] as { opcode: number; payloadData: string };
    if (opcode === WS_CLOSE_OPCODE) diag('gateway-close-frame', { bytes: payloadData.length });
    this.stats.frames++;
    // CDP: opcode 1 = text (UTF-8 as-is), 2 = binary (base64).
    const chunk = opcode === 2 ? Buffer.from(payloadData, 'base64') : Buffer.from(payloadData, 'utf8');
    decoder
      .write(chunk)
      .then((json) => this.onPayload(json, String(params['requestId'])))
      .catch((error: unknown) => {
        this.stats.decodeErrors++;
        if (this.stats.decodeErrors <= TAP_DIAGNOSTIC_FAILURES_LOGGED) {
          diag('gateway-tap-payload-failed', {
            requestId: params['requestId'], opcode, bytes: chunk.length,
            errorName: error instanceof Error ? error.name : typeof error,
            stack: error instanceof Error ? error.stack?.split('\n').slice(1, 4) : undefined,
          });
        }
      });
  }

  /** A text frame sent (the client sends JSON uncompressed); binary ones carry no shape to read. */
  private onSent({ opcode, payloadData }: { opcode: number; payloadData: string }, socketId: string): void {
    if (opcode !== WS_TEXT_OPCODE) return;
    let msg: { op?: unknown; d?: unknown };
    try {
      msg = JSON.parse(payloadData) as { op?: unknown; d?: unknown };
    } catch {
      return;
    }
    if (typeof msg.op === 'number') this.emit('sent', { op: msg.op, d: msg.d, socketId });
  }

  private onPayload(json: string, socketId: string): void {
    this.diagnosticPayloads++;
    const msg = JSON.parse(json) as { op: number; t: string | null; s: number | null; d: unknown };
    if (msg.op === INVALID_SESSION_OP) diag('gateway-invalid-session', { resumable: msg.d });
    if (msg.op !== DISPATCH_OP || !msg.t) return;
    if (msg.t === 'READY') diag('gateway-ready');
    this.stats.events[msg.t] = (this.stats.events[msg.t] ?? 0) + 1;
    this.emit('dispatch', { t: msg.t, s: msg.s, d: msg.d, socketId });
  }
}

/** One decoder per socket; writes are serialized so each frame yields exactly its own payload. */
function makeDecoder(compress: string | null): Decoder {
  if (compress !== 'zstd-stream' && compress !== 'zlib-stream') {
    return { write: (chunk) => Promise.resolve(chunk.toString('utf8')) };
  }
  const stream: ZstdDecompress | Inflate = compress === 'zstd-stream' ? createZstdDecompress() : createInflate();
  const flushKind = compress === 'zstd-stream' ? undefined : constants.Z_SYNC_FLUSH;
  let out: Buffer[] = [];
  stream.on('data', (b: Buffer) => out.push(b));
  let queue: Promise<unknown> = Promise.resolve();
  return {
    write(chunk) {
      const next = queue.then(
        () =>
          new Promise<string>((resolve, reject) => {
            stream.write(chunk, (err) => {
              if (err) return reject(err);
              const done = (): void => {
                const text = Buffer.concat(out).toString('utf8');
                out = [];
                resolve(text);
              };
              if (flushKind === undefined) stream.flush(done);
              else stream.flush(flushKind, done);
            });
          }),
      );
      queue = next.catch(() => undefined);
      return next;
    },
  };
}
