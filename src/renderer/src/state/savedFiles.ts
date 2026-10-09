// Saving an archived attachment to a place the owner picks.
import { api } from '@/api';
import type { ArchiveAttachment } from '@shared/contract';
import { attachmentUrl } from '@shared/media';
import { failureNotice } from './dialogs';
import { inCompanion } from './ui';

/** Whether `a` can be saved: its file is held here. */
export const canSave = (a: ArchiveAttachment): boolean => a.status === 'stored' && a.sha256 !== null;

/** Desktop saves use main dialogs/copies. Phone media shares page origin, allowing native download links. */
export const savesThroughMain = !inCompanion;

/** Saves `a`: on the desktop through main, where a failed copy (a full disk, a folder it may not write to) says why; on the phone as a download, as its file card's link does. */
export function saveAttachment(a: ArchiveAttachment): Promise<void> {
  if (savesThroughMain) return api.media.saveAttachment(a.sha256!, a.filename).catch(failureNotice(`Couldn't save ${a.filename}`));
  Object.assign(document.createElement('a'), { href: attachmentUrl(a.sha256!, a.filename), download: a.filename }).click();
  return Promise.resolve();
}
