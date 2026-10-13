/** Stored replacement formats supported by the archive's encoders. */
export const REPLACEMENT_EXTS = ['mp4', 'webp'] as const;
export type ReplacementExt = (typeof REPLACEMENT_EXTS)[number];
export const isReplacementExt = (ext: unknown): ext is ReplacementExt =>
  typeof ext === 'string' && (REPLACEMENT_EXTS as readonly string[]).includes(ext);

/** Encoding gets most of the progress range; copying encoded bytes uses the rest. */
export const ARCHIVE_ENCODE_PROGRESS_SHARE = 0.9;
