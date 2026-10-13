import { GENERIC_CONTENT_TYPE, STORED_MEDIA_MIME } from '@shared/media';

const MEDIA_KINDS = ['image', 'audio', 'video'] as const;

/** SQLite's built-in functions classify attachments by the same type and final-extension rules as mediaKind. */
export function attachmentKindSql(contentTypeCol: string, filenameCol: string): string {
  const byExtension = MEDIA_KINDS.map((kind) => {
    const extensions = Object.entries(STORED_MEDIA_MIME).filter(([, mime]) => mime.split('/')[0] === kind);
    const matches = extensions.map(([ext]) => `substr(lower(${filenameCol}), -${ext.length + 1}) = '.${ext}'`).join(' OR ');
    return `WHEN ${matches} THEN '${kind}'`;
  }).join('\n');
  const byType = MEDIA_KINDS.map((kind) =>
    `WHEN ${contentTypeCol} = '${kind}' COLLATE BINARY OR substr(${contentTypeCol}, 1, ${kind.length + 1}) = '${kind}/' COLLATE BINARY THEN '${kind}'`,
  ).join('\n');
  return `CASE WHEN ${contentTypeCol} IS NULL OR ${contentTypeCol} = '' OR ${contentTypeCol} = '${GENERIC_CONTENT_TYPE}' COLLATE BINARY
    THEN CASE ${byExtension} ELSE 'file' END
    ELSE CASE ${byType} ELSE 'file' END END`;
}
