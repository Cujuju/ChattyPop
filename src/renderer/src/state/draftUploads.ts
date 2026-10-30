// Draft uploads live only in this page; IndexedDB keeps files without their upload associations.
import { unwrap } from 'solid-js/store';
import type { SavedDraftFile } from './draftFiles';

type Phase = 'preparing' | 'uploading';
interface Result { file: SavedDraftFile; token: string }
interface Upload {
  channelId: string;
  accountId: string | null;
  original: SavedDraftFile;
  active: boolean;
  claimed: boolean;
  phase: Phase;
  progress: number;
  observer?: (phase: Phase, progress: number) => void;
  done: Promise<Result | null>;
}
interface Deps {
  unlocked(): boolean;
  accountId(): string | null;
  prepare(channelId: string, files: File[], progress: (p: number) => void): Promise<File[]>;
  upload(channelId: string, accountId: string | null, files: SavedDraftFile[], progress: (p: number) => void): Promise<string[]>;
}
const uploads = new WeakMap<object, Upload>();
let deps: Deps | undefined;
export const configureDraftUploads = (value: Deps): void => { deps = value; };

export function copyDraftUpload(from: object, to: object): void {
  const upload = uploads.get(unwrap(from));
  if (upload) uploads.set(unwrap(to), upload);
}

export function abandonDraftUpload(file: object): void {
  const upload = uploads.get(unwrap(file));
  if (upload) upload.active = false;
  uploads.delete(unwrap(file));
}

export function startDraftUpload(channelId: string, file: SavedDraftFile): void {
  const d = deps;
  if (!d?.unlocked()) return;
  const accountId = d.accountId();
  const original = { ...file };
  const upload: Upload = { channelId, accountId, original, active: true, claimed: false, phase: 'preparing', progress: 0, done: Promise.resolve(null) };
  uploads.set(unwrap(file), upload);
  const report = (phase: Phase, progress: number): void => {
    upload.phase = phase;
    upload.progress = progress;
    upload.observer?.(phase, progress);
  };
  upload.done = (async () => {
    const [prepared] = await d.prepare(channelId, [file.file], (p) => report('preparing', p));
    if (!upload.active || !d.unlocked()) return null;
    const ready = { ...original, file: prepared! };
    report('uploading', 0);
    const [token] = await d.upload(channelId, accountId, [ready], (p) => report('uploading', p));
    return upload.active ? { file: ready, token: token! } : null;
  })().catch(() => null);
}

export async function takeDraftUpload(channelId: string, accountId: string | null, file: SavedDraftFile, progress: (phase: Phase, p: number) => void): Promise<Result | null> {
  const upload = uploads.get(unwrap(file));
  if (!upload?.active || upload.claimed || upload.channelId !== channelId || upload.accountId !== accountId || upload.original.file !== file.file || upload.original.description !== file.description || upload.original.spoiler !== file.spoiler) return null;
  uploads.delete(unwrap(file));
  upload.claimed = true;
  upload.observer = progress;
  progress(upload.phase, upload.progress);
  try {
    const result = await upload.done;
    const current = upload.active ? result : null;
    upload.active = false;
    return current;
  } finally {
    upload.observer = undefined;
  }
}
