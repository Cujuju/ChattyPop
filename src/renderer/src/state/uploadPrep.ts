// Readies a message's files for upload. The video encoder (#89) plugs in here: videos shrink to this device's quality.
/** The files as they'll be uploaded; `progress` reports the share done. */
export async function prepareFiles(_channelId: string, files: File[], progress: (fraction: number) => void): Promise<File[]> {
  progress(1);
  return files;
}
