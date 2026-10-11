// The host bundles this worker, so installed transports need no SDK namespace inside their own worker.
import { decodeWire } from '@shared/wire';
import type { WireDecodeReply, WireDecodeRequest } from './wireWorkerProtocol';

const worker = globalThis as unknown as {
  onmessage: (event: { data: WireDecodeRequest }) => void;
  postMessage(reply: WireDecodeReply): void;
};

worker.onmessage = ({ data: { id, text, format } }) => {
  let reply: WireDecodeReply;
  try {
    reply = { id, ok: true, value: format === 'wire' ? decodeWire(text) : JSON.parse(text) };
  } catch (error) {
    reply = { id, ok: false, error: error instanceof Error ? error.message : String(error) };
  }
  worker.postMessage(reply);
};
