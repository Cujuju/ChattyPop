// A plugin's loopback HTTP server (main ctx.net.listen): reachable from this PC only; the plugin publishes it further.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Only this PC reaches a plugin's server directly. */
const LOOPBACK = '127.0.0.1';
const HTTP_INTERNAL_ERROR = 500;

/** Answers one request; a throw or rejection becomes a 500 (or a cut connection once the reply started). */
export type LoopbackHandler = (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;

/** A listening loopback server. */
export interface LoopbackServer {
  /** The bound port (the requested one, or the free one the OS chose for 0). */
  readonly port: number;
  /** Stops listening and closes active connections, including long calls/event streams. */
  close(): Promise<void>;
}

/**
 * Listens on 127.0.0.1:`port`; rejects with the listen error (EADDRINUSE when the port is taken). A handler's escaped
 * error goes to `failed` and ends that request, never the process's unhandled-rejection path.
 */
export function listenLoopback(port: number, handler: LoopbackHandler, failed: (error: unknown) => void): Promise<LoopbackServer> {
  const server = createServer((req, res) => {
    void (async () => handler(req, res))().catch((err: unknown) => {
      failed(err);
      if (res.headersSent) res.destroy();
      else res.writeHead(HTTP_INTERNAL_ERROR).end();
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      resolve({
        port: (server.address() as AddressInfo).port,
        close: () => {
          const closed = new Promise<void>((done) => server.close(() => done()));
          server.closeAllConnections();
          return closed;
        },
      });
    });
  });
}
