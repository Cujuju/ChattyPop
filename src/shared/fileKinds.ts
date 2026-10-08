// What kind of file an attachment is, for its type icon: Discord's file-icon families, by ending and content type.
import { mediaKind } from './media';
import { isTextFile, textExtension } from './textFiles';

export type FileKind = 'image' | 'video' | 'audio' | 'archive' | 'pdf' | 'document' | 'spreadsheet' | 'slides' | 'code' | 'unknown';

/** The kind's name, read out with its icon. */
export const FILE_KIND_LABEL: Readonly<Record<FileKind, string>> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  archive: 'Archive',
  pdf: 'PDF',
  document: 'Document',
  spreadsheet: 'Spreadsheet',
  slides: 'Presentation',
  code: 'Code',
  unknown: 'File',
};

/** Endings of each kind Discord gives its own icon; a text ending not listed here is code. */
const KIND_EXTENSIONS: ReadonlyArray<readonly [FileKind, ReadonlySet<string>]> = [
  ['pdf', new Set(['pdf'])],
  ['archive', new Set(['zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'zst', 'lz', 'cab', 'iso', 'dmg', 'jar', 'apk'])],
  ['spreadsheet', new Set(['csv', 'tsv', 'xls', 'xlsx', 'xlsm', 'ods', 'numbers'])],
  ['slides', new Set(['ppt', 'pptx', 'odp', 'key'])],
  // Prose: word processors' files and the text endings that hold writing, not source.
  ['document', new Set(['doc', 'docx', 'odt', 'rtf', 'pages', 'epub', 'txt', 'text', 'plaintext', 'log', 'md', 'markdown', 'mkd', 'mkdown', 'asciidoc', 'adoc', 'srt', 'vtt'])],
];

/** A name's ending, as the type a cut-off name can't show: upper-cased, else the kind's name when it has none (Dockerfile). */
export function fileTypeLabel(a: { contentType: string | null; filename: string }): string {
  const dot = a.filename.lastIndexOf('.');
  return dot > 0 && dot < a.filename.length - 1 ? a.filename.slice(dot + 1).toUpperCase() : FILE_KIND_LABEL[fileKind(a)];
}

/** An image keeps its kind whatever its ending (svg); a text ending wins over a media content type (main.ts as video/mp2t), as attachmentView does. */
export function fileKind(a: { contentType: string | null; filename: string }): FileKind {
  const media = mediaKind(a);
  if (media === 'image') return 'image';
  const ext = textExtension(a.filename);
  const listed = KIND_EXTENSIONS.find(([, exts]) => exts.has(ext))?.[0];
  if (listed) return listed;
  if (isTextFile(a.filename)) return 'code';
  return media === 'file' ? 'unknown' : media;
}
