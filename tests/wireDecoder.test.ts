import { describe, expect, it, vi } from 'vitest';
import { createWireDecoder, type DecoderWorker as WorkerBoundary } from '../src/plugin-sdk/renderer/shell/wireDecoder';
import type { WireDecodeReply, WireDecodeRequest } from '../src/plugin-sdk/renderer/shell/wireWorkerProtocol';

class DecoderWorker implements WorkerBoundary {
  onmessage: WorkerBoundary['onmessage'] = null;
  onerror: WorkerBoundary['onerror'] = null;
  onmessageerror: WorkerBoundary['onmessageerror'] = null;
  requests: WireDecodeRequest[] = [];
  terminate = vi.fn();
  postMessage = vi.fn((request: WireDecodeRequest) => this.requests.push(request));
  reply(reply: WireDecodeReply): void {
    this.onmessage?.({ data: reply });
  }
}

function harness() {
  const worker = new DecoderWorker();
  const factory = vi.fn(() => worker);
  return { worker, factory, decoder: createWireDecoder(factory) };
}

describe('page response decoding worker', () => {
  it('starts lazily and matches overlapping responses by id, preserving bytes and undefined', async () => {
    const { worker, factory, decoder } = harness();
    expect(factory).not.toHaveBeenCalled();
    const first = decoder.decode('{"first":1}');
    const second = decoder.decode('{"second":2}');
    expect(factory).toHaveBeenCalledTimes(1);
    const value = { bytes: new Uint8Array([0, 255]), missing: undefined, list: [undefined] };
    worker.reply({ id: worker.requests[1]!.id, ok: true, value: structuredClone(value) });
    worker.reply({ id: worker.requests[0]!.id, ok: true, value: 1 });
    expect(await first).toBe(1);
    expect(await second).toEqual(value);
    decoder.dispose();
  });

  it('rejects malformed input without breaking the next decode or other pending reads', async () => {
    const { worker, decoder } = harness();
    const invalid = expect(decoder.decode('bad')).rejects.toThrow('Invalid JSON');
    const valid = decoder.decode('{}', 'json');
    expect(worker.requests[1]!.format).toBe('json');
    worker.reply({ id: worker.requests[0]!.id, ok: false, error: 'Invalid JSON' });
    worker.reply({ id: worker.requests[1]!.id, ok: true, value: {} });
    await invalid;
    expect(await valid).toEqual({});
    decoder.dispose();
  });

  it.each(['error', 'messageerror'])('rejects all outstanding reads on %s and starts a fresh worker for the next read', async (type) => {
    const workers = [new DecoderWorker(), new DecoderWorker()];
    let index = 0;
    const decoder = createWireDecoder(() => workers[index++]!);
    const first = expect(decoder.decode('1')).rejects.toThrow(/decoder/);
    const second = expect(decoder.decode('2')).rejects.toThrow(/decoder/);
    if (type === 'error') workers[0]!.onerror?.({ preventDefault: vi.fn() });
    else workers[0]!.onmessageerror?.();
    await Promise.all([first, second]);
    expect(workers[0]!.terminate).toHaveBeenCalledOnce();
    const next = decoder.decode('3');
    // A late reply from the stopped worker cannot settle the new worker's request.
    workers[0]!.reply({ id: workers[1]!.requests[0]!.id, ok: true, value: 'stale' });
    workers[1]!.reply({ id: workers[1]!.requests[0]!.id, ok: true, value: 3 });
    expect(await next).toBe(3);
    decoder.dispose();
  });

  it('rejects startup and posting failures instead of leaving the request pending', async () => {
    const unavailable = createWireDecoder(() => { throw new Error('Worker unavailable'); });
    await expect(unavailable.decode('1')).rejects.toThrow('Worker unavailable');
    unavailable.dispose();
    const { worker, decoder } = harness();
    worker.postMessage.mockImplementationOnce(() => { throw new Error('Clone failed'); });
    await expect(decoder.decode('1')).rejects.toThrow('Clone failed');
    const next = decoder.decode('2');
    worker.reply({ id: worker.requests[0]!.id, ok: true, value: 2 });
    expect(await next).toBe(2);
    decoder.dispose();
  });

  it('settles pending reads on disposal and refuses further work', async () => {
    const { worker, decoder } = harness();
    const reading = expect(decoder.decode('1')).rejects.toThrow('stopped');
    decoder.dispose();
    await reading;
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(decoder.decode('2')).rejects.toThrow('stopped');
  });
});
