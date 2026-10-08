import { api } from '@/api';
import { createEffect, createResource, createSignal } from 'solid-js';
import type { AppEvent } from '@shared/contract';
import { formatBytes } from '@/ui/format';
import { confirmDialog, noticeDialog } from './dialogs';
import { onAppEvent } from './events';

/** Archive folder, and the pre-move copy while it is still on disk. */
export const [storageInfo, { refetch: refetchStorageInfo }] = createResource(() => api.storage.info());

type MoveProgress = Extract<AppEvent, { type: 'storage-move' }>;
/** Progress of an archive move in flight; null when none. */
export const [storageMove, setStorageMove] = createSignal<MoveProgress | null>(null);
onAppEvent('storage-move', (e) => setStorageMove(e));

export const moveArchive = (): Promise<void> => api.storage.move();

/** Asks, then deletes the copy a move left behind. */
export async function deletePreviousArchive(): Promise<void> {
  const info = storageInfo();
  if (!info?.previousDir) return;
  const ok = await confirmDialog({
    title: 'Delete the old copy',
    message: `Delete the old copy of the archive? ${formatBytes(info.previousBytes ?? 0)} in ${info.previousDir} (the database and media folder only). The archive in ${info.dir} is not affected. This can’t be undone.`,
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  await api.storage.deletePrevious();
  await refetchStorageInfo();
}

/** Main window: shows once what main left across a restart it caused (a failed move or check), then drops it. */
export function showStorageNotice(): void {
  let shown = false;
  createEffect(() => {
    const notice = storageInfo()?.notice;
    if (!notice || shown) return;
    shown = true;
    void noticeDialog(notice)
      .then(() => api.storage.dismissNotice())
      .then(refetchStorageInfo);
  });
}
