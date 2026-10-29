import type { NoteArchiveChange } from '@shared/archiveChanges';
import { noteAttachmentChange } from './archiveChangeSource';
import type { CoreMethods } from '@shared/contract';
import { snowflakeArg } from '@shared/discord';
import { FREE_ATTACHMENTS_MAX } from '@shared/types/attachmentStore';
import { SHA256_HEX } from '@shared/media';
import { freeAttachments, removeUnnamedFiles, replaceStoredFile, storedFileOf } from './attachmentStore';
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
    let replaced: ReturnType<typeof replaceStoredFile>;
    try {
      replaced = replaceStoredFile(db(), attachmentsDir(), r, Date.now());
    } catch (err) {
      // The re-encode main published is unused: removed unless a download recorded the same content meanwhile.
      if (typeof r?.newSha256 === 'string' && SHA256_HEX.test(r.newSha256)) removeUnnamedFiles(db(), attachmentsDir(), r.newSha256);
      throw err;
    }
    const { channelIds, ...result } = replaced;
    const affected = new Set(channelIds);
    for (const id of ids) {
      const channelId = db().prepare('SELECT channel_id FROM attachments WHERE id = ?').pluck().get(id) as string | undefined;
      if (channelId && affected.has(channelId)) noteAttachmentChange(db(), changed, id, true);
    }
    return result;
  },
  storedFile: (id) => storedFileOf(db(), snowflakeArg(id, 'attachment')),
});
