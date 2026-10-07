import { EventEmitter } from 'node:events';
import { createInflate, createZstdDecompress, constants, type Inflate, type ZstdDecompress } from 'node:zlib';
import type { WebContents } from 'electron';
import { diag } from '../diagnostics';

/** Gateway dispatch as the client received it. `t` is the event name, `d` its payload. */
export interface GatewayDispatch {
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

type Decoder = { write(chunk: Buffer): Promise<string> };

/** A frame sent on the gateway socket: its opcode and payload. */
export interface GatewaySend {
  op: number;
  d: unknown;
}

/**
 * Reads the embedded client's own gateway traffic through CDP; sends nothing to Discord. `sent` is a frame the client
 * sent, `ownSent` one ChattyPop sent on its socket (marked with own()).
 * Must attach before the page opens its socket: compressed streams can't be decoded mid-stream.
 */
export class GatewayTap extends EventEmitter<{ dispatch: [GatewayDispatch]; sent: [GatewaySend]; ownSent: [GatewaySend] }> {
  readonly stats: GatewayTapStats = { url: null, compress: null, frames: 0, decodeErrors: 0, events: {} };
  private readonly decoders = new Map<string, Decoder>();
  /** Frames ChattyPop is sending, as text: told apart from the client's when CDP reports them. */
  private readonly ownFrames = new Map<string, number>();

  constructor(wc: WebContents) {
    super();
    wc.debugger.attach(CDP_PROTOCOL_VERSION);
    wc.debugger.on('message', (_e, method, params) => this.onCdp(method, params));
    void wc.debugger.sendCommand('Network.enable');
  }

  private onCdp(method: string, params: Record<string, unknown>): void {
    if (method === 'Network.webSocketCreated') {
      const url = String(params['url']);
      if (!GATEWAY_HOST.test(new URL(url).hostname)) return;
      const compress = new URL(url).searchParams.get('compress');
      this.stats.url = url;
      this.stats.compress = compress;
      this.decoders.set(String(params['requestId']), makeDecoder(compress));
      return;
    }
    if (method === 'Network.webSocketFrameSent') {
      if (this.decoders.has(String(params['requestId']))) this.onSent(params['response'] as { opcode: number; payloadData: string });
      return;
    }
    if (method === 'Network.webSocketClosed') {
      if (this.decoders.delete(String(params['requestId']))) diag('gateway-socket-closed');
      return;
    }
    if (method !== 'Network.webSocketFrameReceived') return;
    const decoder = this.decoders.get(String(params['requestId']));
    if (!decoder) return;
    const { opcode, payloadData } = params['response'] as { opcode: number; payloadData: string };
    if (opcode === WS_CLOSE_OPCODE) diag('gateway-close-frame', { bytes: payloadData.length });
    this.stats.frames++;
    // CDP: opcode 1 = text (UTF-8 as-is), 2 = binary (base64).
    const chunk = opcode === 2 ? Buffer.from(payloadData, 'base64') : Buffer.from(payloadData, 'utf8');
    decoder
      .write(chunk)
      .then((json) => this.onPayload(json))
      .catch(() => this.stats.decodeErrors++);
  }

  /** Marks `frame` as ChattyPop's, before it is sent on the client's socket. */
  own(frame: string): void {
    this.ownFrames.set(frame, (this.ownFrames.get(frame) ?? 0) + 1);
  }

  /** A text frame sent (the client sends JSON uncompressed); binary ones carry no shape to read. */
  private onSent({ opcode, payloadData }: { opcode: number; payloadData: string }): void {
    if (opcode !== WS_TEXT_OPCODE) return;
    const mine = this.ownFrames.get(payloadData);
    if (mine) {
      if (mine > 1) this.ownFrames.set(payloadData, mine - 1);
      else this.ownFrames.delete(payloadData);
    }
    let msg: { op?: unknown; d?: unknown };
    try {
      msg = JSON.parse(payloadData) as { op?: unknown; d?: unknown };
    } catch {
      return;
    }
    if (typeof msg.op === 'number') this.emit(mine ? 'ownSent' : 'sent', { op: msg.op, d: msg.d });
  }

  private onPayload(json: string): void {
    const msg = JSON.parse(json) as { op: number; t: string | null; s: number | null; d: unknown };
    if (msg.op === INVALID_SESSION_OP) diag('gateway-invalid-session', { resumable: msg.d });
    if (msg.op !== DISPATCH_OP || !msg.t) return;
    if (msg.t === 'READY') diag('gateway-ready');
    this.stats.events[msg.t] = (this.stats.events[msg.t] ?? 0) + 1;
    this.emit('dispatch', { t: msg.t, s: msg.s, d: msg.d });
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
