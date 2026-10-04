import { api } from '@/api';
import { createResource, createSignal } from 'solid-js';
import type { AppEvent } from '@shared/contract';
import { onAppEvent } from './events';

/** Archive folder, and the pre-move copy while it is still on disk. */
export const [storageInfo, { refetch: refetchStorageInfo }] = createResource(() => api.storage.info());

type MoveProgress = Extract<AppEvent, { type: 'storage-move' }>;
/** Progress of an archive move in flight; null when none. */
export const [storageMove, setStorageMove] = createSignal<MoveProgress | null>(null);
onAppEvent('storage-move', (e) => setStorageMove(e));

export const moveArchive = (): Promise<void> => api.storage.move();

export async function deletePreviousArchive(): Promise<void> {
  await api.storage.deletePrevious();
  await refetchStorageInfo();
}
