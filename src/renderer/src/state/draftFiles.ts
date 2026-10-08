// Cloneable entries shared by drafts and the outbox; legacy records held bare Files.
import type { FileOptions } from '@shared/compose';

export interface SavedDraftFile extends FileOptions {
  file: File;
}
export type DraftFileInput = File | ({ file: File } & Partial<FileOptions>);

export function savedDraftFile(input: DraftFileInput): SavedDraftFile {
  return 'file' in input
    ? { file: input.file, description: input.description ?? '', spoiler: input.spoiler ?? false }
    : { file: input, description: '', spoiler: false };
}
