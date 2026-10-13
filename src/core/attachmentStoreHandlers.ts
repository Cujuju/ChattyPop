import type { CoreMethods } from '@shared/contract';
import { snowflakeArg } from '@shared/discord';
import { FREE_ATTACHMENTS_MAX } from '@shared/types/attachmentStore';
import { freeAttachments, replaceStoredFile, storedFileOf } from './attachmentStore';
import type { Db } from './db';

/** Owner file operations notify the same channel changes as archive writes. */
export const attachmentStoreHandlers = (
  db: () => Db,
  attachmentsDir: () => string,
  changed: (channelId: string) => void,
): Pick<CoreMethods, 'freeAttachments' | 'attachmentRecompressed' | 'storedFile'> => ({
  freeAttachments: (ids) => {
    if (!Array.isArray(ids) || ids.length > FREE_ATTACHMENTS_MAX) throw new Error('Not a bounded attachment list.');
    for (const id of ids) snowflakeArg(id, 'attachment');
    const { channelIds, ...result } = freeAttachments(db(), attachmentsDir(), ids);
    channelIds.forEach((id) => changed(id));
    return result;
  },
  attachmentRecompressed: (r) => {
    const { channelIds, ...result } = replaceStoredFile(db(), attachmentsDir(), r, Date.now());
    channelIds.forEach((id) => changed(id));
    return result;
  },
  storedFile: (id) => storedFileOf(db(), snowflakeArg(id, 'attachment')),
});
