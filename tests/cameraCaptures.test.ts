// Camera captures reach the iPhone app's Photos handler in ordered base64 pieces, one in flight, only when the device asks.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SHELL_SAVE_MEDIA_HANDLER, type ShellMediaPiece } from '@shared/shell';
import { DEFAULT_DEVICE_CHAT_SETTINGS, type DeviceChatSettings } from '@shared/chatSettings';

const device = vi.hoisted(() => ({ settings: null as DeviceChatSettings | null }));
vi.mock('../src/renderer/src/state/chatSettings', () => ({ deviceChatSettings: () => device.settings }));

// A path import keeps DOM types outside node type checking.
const capturesPath = '../src/renderer/src/phone/cameraCaptures';
const { MEDIA_PIECE_BYTES, saveCameraCaptures } = (await import(capturesPath)) as { MEDIA_PIECE_BYTES: number; saveCameraCaptures(files: readonly File[]): void };

/** FileReader's data-URL read, which Node lacks. */
class DataUrlReader {
  result: string | null = null;
  error: Error | null = null;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  readAsDataURL(blob: Blob): void {
    void blob.arrayBuffer().then((bytes) => {
      this.result = `data:application/octet-stream;base64,${Buffer.from(bytes).toString('base64')}`;
      this.onload?.();
    });
  }
}

let pieces: ShellMediaPiece[];
let inFlight: number;
let maxInFlight: number;
let fail: ((piece: ShellMediaPiece) => boolean) | null;

/** The app's handler: answers each piece on a later turn, as WebKit's reply does. */
const postMessage = (piece: ShellMediaPiece): Promise<undefined> => {
  pieces.push(piece);
  inFlight++;
  maxInFlight = Math.max(maxInFlight, inFlight);
  return new Promise((resolve, reject) =>
    setTimeout(() => {
      inFlight--;
      if (fail?.(piece)) reject(new Error('not saved'));
      else resolve(undefined);
    }),
  );
};

/** Byte pattern period: prime, so piece boundaries never line up with it. */
const BYTE_PERIOD = 251;
/** A queued capture posts its first piece within a few macrotasks; waiting this long shows none was queued. */
const SETTLE_MS = 20;
const capture = (size: number, type: string): File => new File([new Uint8Array(size).map((_, i) => i % BYTE_PERIOD)], 'capture', { type });
const bytesOf = (id: string): Buffer => Buffer.concat(pieces.filter((p) => p.id === id).map((p) => Buffer.from(p.data, 'base64')));

beforeEach(() => {
  pieces = [];
  inFlight = 0;
  maxInFlight = 0;
  fail = null;
  device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, saveCameraToDevice: true };
  vi.stubGlobal('FileReader', DataUrlReader);
  vi.stubGlobal('webkit', { messageHandlers: { [SHELL_SAVE_MEDIA_HANDLER]: { postMessage } } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('saveCameraCaptures', () => {
  it('sends a capture as ordered pieces, one at a time, that rebuild its bytes', async () => {
    const file = capture(2 * MEDIA_PIECE_BYTES + 3, 'video/quicktime');
    saveCameraCaptures([file]);
    await vi.waitFor(() => expect(pieces.length).toBe(3));
    await vi.waitFor(() => expect(inFlight).toBe(0));
    expect(pieces.map((p) => [p.index, p.last])).toEqual([[0, false], [1, false], [2, true]]);
    expect(new Set(pieces.map((p) => p.id)).size).toBe(1);
    expect(pieces.every((p) => p.type === 'video/quicktime')).toBe(true);
    expect(maxInFlight).toBe(1);
    expect(bytesOf(pieces[0]!.id).equals(Buffer.from(await file.arrayBuffer()))).toBe(true);
  });

  it('sends captures one after another, and a failed one does not stop the next', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fail = (p) => p.index === 0 && pieces.length === 1;
    saveCameraCaptures([capture(MEDIA_PIECE_BYTES + 1, 'image/jpeg'), capture(5, 'image/jpeg')]);
    await vi.waitFor(() => expect(pieces.length).toBe(2));
    await vi.waitFor(() => expect(inFlight).toBe(0));
    // The first capture stopped at its failed piece; the second came whole, with its own id.
    expect(pieces.map((p) => [p.index, p.last])).toEqual([[0, false], [0, true]]);
    expect(pieces[0]!.id).not.toBe(pieces[1]!.id);
    expect(bytesOf(pieces[1]!.id)).toEqual(Buffer.from([0, 1, 2, 3, 4]));
    expect(error).toHaveBeenCalledOnce();
  });

  it('sends an empty capture as one last piece', async () => {
    saveCameraCaptures([capture(0, 'image/jpeg')]);
    await vi.waitFor(() => expect(pieces).toEqual([expect.objectContaining({ index: 0, last: true, data: '' })]));
  });

  it('does nothing when the device does not ask, or outside the app', async () => {
    device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, saveCameraToDevice: false };
    saveCameraCaptures([capture(5, 'image/jpeg')]);
    device.settings = { ...DEFAULT_DEVICE_CHAT_SETTINGS, saveCameraToDevice: true };
    vi.stubGlobal('webkit', undefined);
    expect(() => saveCameraCaptures([capture(5, 'image/jpeg')])).not.toThrow();
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(pieces).toEqual([]);
  });
});
