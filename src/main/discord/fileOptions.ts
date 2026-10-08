// A new upload's alt text and spoiler mark, checked as they come from the renderer.
import { ALT_TEXT_MAX, type FileOptions } from '@shared/compose';

/** Checks options before either upload path asks Discord for slots. */
export function checkFileOptions(value: Partial<FileOptions>): FileOptions {
  const { description = '', spoiler = false } = value;
  if (typeof description !== 'string' || typeof spoiler !== 'boolean') throw new Error('Not attachment options.');
  if (description.length > ALT_TEXT_MAX) throw new Error(`Discord allows ${ALT_TEXT_MAX} characters of alt text.`);
  return { description, spoiler };
}
