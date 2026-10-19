import type { NoteArchiveChange } from '@shared/archiveChanges';
import { noteAttachmentChange } from './archiveChangeSource';
import type { CoreMethods } from '@shared/contract';
import { snowflakeArg } from '@shared/discord';
import { FREE_ATTACHMENTS_MAX } from '@shared/types/attachmentStore';
import { freeAttachments, replaceStoredFile, storedFileOf } from './attachmentStore';
import type { Db } from './db';

/** Owner file operations notify the same channel changes as archive writes. */
export const attachmentStoreHandlers = (
  db: () => Db,
  attachmentsDir: () => string,
  changed: NoteArchiveChange,
): Pick<CoreMethods, 'freeAttachments' | 'attachmentRecompressed' | 'storedFile'> => ({
  freeAttachments: (ids) => {
    if (!Array.isArray(ids) || ids.length > FREE_ATTACHMENTS_MAX) throw new Error('Not a bounded attachment list.');
    for (const id of ids) snowflakeArg(id, 'attachment');
    const { channelIds, ...result } = freeAttachments(db(), attachmentsDir(), ids);
    const affected = new Set(channelIds);
    for (const id of ids) {
      const channelId = db().prepare('SELECT channel_id FROM attachments WHERE id = ?').pluck().get(id) as string | undefined;
      if (channelId && affected.has(channelId)) noteAttachmentChange(db(), changed, id, true);
    }
    return result;
  },
  attachmentRecompressed: (r) => {
    const ids = db().prepare('SELECT id FROM attachments WHERE sha256 = ?').pluck().all(r.sha256) as string[];
    const { channelIds, ...result } = replaceStoredFile(db(), attachmentsDir(), r, Date.now());
    const affected = new Set(channelIds);
    for (const id of ids) {
      const channelId = db().prepare('SELECT channel_id FROM attachments WHERE id = ?').pluck().get(id) as string | undefined;
      if (channelId && affected.has(channelId)) noteAttachmentChange(db(), changed, id, true);
    }
    return result;
  },
  storedFile: (id) => storedFileOf(db(), snowflakeArg(id, 'attachment')),
});
