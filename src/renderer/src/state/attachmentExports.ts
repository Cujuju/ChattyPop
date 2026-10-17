import { api } from '@/api';
import { onServerScreen } from './ui';
import type { StoredAttachmentRef } from './storedAttachments';
import type { FolderSaveProgress, FolderSaveResult } from '@shared/types/attachmentStore';

export const canSaveAttachmentsToFolder = onServerScreen;
export type { FolderSaveProgress, FolderSaveResult };

/** Progress is scoped to this request and window; concurrent exports cannot update each other's bars. */
export async function saveAttachmentsToFolder(refs: StoredAttachmentRef[], progress?: (p: FolderSaveProgress) => void): Promise<FolderSaveResult | null> {
  if (!canSaveAttachmentsToFolder) throw new Error('Saving to a folder is only on the archive PC.');
  if (refs.some((r) => r.status !== 'stored')) throw new Error('Not an archived attachment.');
  const requestId = crypto.randomUUID();
  const off = api.onEvent((e) => { if (e.type === 'attachment-save-progress' && e.requestId === requestId) progress?.({ done: e.done, total: e.total }); });
  try { return await api.media.saveAttachmentsToFolder(refs, requestId); }
  finally { off(); }
}

export const showAttachmentFolder = (folder: string): Promise<void> => api.media.showAttachmentFolder(folder);
export const startFileDrag = (ref: StoredAttachmentRef): Promise<void> => {
  if (!canSaveAttachmentsToFolder || ref.status !== 'stored') return Promise.reject(new Error('Not a local stored attachment.'));
  return api.media.startFileDrag(ref);
};
