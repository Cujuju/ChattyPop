// Saving an archived attachment to a place the owner picks.
import { api } from '@/api';
import type { ArchiveAttachment } from '@shared/contract';
import { errorText } from '@/ui/format';
import { inCompanion } from './ui';

/** Whether `a` can be saved: its file is held here. */
export const canSave = (a: ArchiveAttachment): boolean => a.status === 'stored' && a.sha256 !== null;

/**
 * A window asks main, which shows a save dialog and copies the file. The phone's page needs nothing: its media route is
 * its own origin, so the link's `download` saves there.
 */
export const savesThroughMain = !inCompanion;

/** Saves `a`; a failed copy (a full disk, a folder it may not write to) says why. */
export const saveAttachment = (a: ArchiveAttachment): Promise<void> =>
  api.media.saveAttachment(a.sha256!, a.filename).catch((err: unknown) => window.alert(`Couldn't save ${a.filename}: ${errorText(err)}`));
