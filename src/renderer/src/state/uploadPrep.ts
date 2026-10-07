// Readies a message's files for upload: videos re-encode to this device's quality (videoEncode.ts) within the channel's limit.
import { api } from '@/api';
import { effectiveVideoQuality, prepareUpload } from './videoEncode';

/** The files as they'll be uploaded; `progress` reports the share done. Rejects with VideoUploadError when a video can't fit. */
export async function prepareFiles(channelId: string, files: File[], progress: (fraction: number) => void): Promise<File[]> {
  const limitBytes = await api.discord.uploadLimit(channelId);
  const quality = effectiveVideoQuality();
  const prepared: File[] = [];
  for (const [i, file] of files.entries()) prepared.push(await prepareUpload(file, quality, { limitBytes, onProgress: (p) => progress((i + p) / files.length) }));
  progress(1);
  return prepared;
}
