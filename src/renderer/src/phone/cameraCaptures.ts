// Camera captures saved to the phone's Photos through the iPhone app (ShellMediaSaver.swift), when this device's chat
// settings ask. Elsewhere (a browser, the desktop, an app built without the handler) nothing happens.
import { SHELL_SAVE_MEDIA_HANDLER, type ShellMediaPiece } from '@shared/shell';
import { deviceChatSettings } from '@/state/chatSettings';

/** Raw bytes per message: each piece is copied as base64 text in the page and the app, so this bounds both (about 5.6 MB of text). */
export const MEDIA_PIECE_BYTES = 4 * 1024 * 1024;

interface MediaHandler {
  postMessage(piece: ShellMediaPiece): Promise<unknown>;
}

const mediaHandler = (): MediaHandler | undefined =>
  (globalThis as { webkit?: { messageHandlers?: Record<string, MediaHandler | undefined> } }).webkit?.messageHandlers?.[SHELL_SAVE_MEDIA_HANDLER];

/** A blob's bytes as base64, through the browser's own encoder. */
function base64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const url = String(reader.result);
      resolve(url.slice(url.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the capture.'));
    reader.readAsDataURL(blob);
  });
}

/** Sends one capture piece by piece, each after the app has written the one before, so one piece is in flight at a time. */
async function sendCapture(handler: MediaHandler, file: File): Promise<void> {
  const id = crypto.randomUUID();
  const count = Math.max(1, Math.ceil(file.size / MEDIA_PIECE_BYTES));
  for (let index = 0; index < count; index++) {
    const data = await base64(file.slice(index * MEDIA_PIECE_BYTES, (index + 1) * MEDIA_PIECE_BYTES));
    await handler.postMessage({ id, index, last: index === count - 1, type: file.type, data });
  }
}

/** Captures go one after another: the app keeps one unfinished capture at a time. */
let saving: Promise<void> = Promise.resolve();

/** Saves photos and videos just taken with the in-app camera to the device's Photos, when its chat settings ask. Not for picked files. */
export function saveCameraCaptures(files: readonly File[]): void {
  const handler = mediaHandler();
  if (!handler || !deviceChatSettings().saveCameraToDevice) return;
  for (const file of files) {
    saving = saving.then(() => sendCapture(handler, file)).catch((err: unknown) => console.error('Could not save the capture to Photos.', err));
  }
}
