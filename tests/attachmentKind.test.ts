import { afterEach, describe, expect, it } from 'vitest';
import { GENERIC_CONTENT_TYPE, STORED_MEDIA_MIME, mediaKind } from '@shared/media';
import { attachmentKindSql } from '../src/core/queries/attachmentKind';
import { tempDb } from './helpers';
import type { Db } from '../src/core/db';

let db: Db | undefined;
afterEach(() => db?.close());

describe('attachment kind SQL', () => {
  it('matches mediaKind using only built-in functions over a fixture table', () => {
    db = tempDb();
    db.exec('CREATE TEMP TABLE kinds (content_type TEXT, filename TEXT NOT NULL)');
    const filenames = [...Object.keys(STORED_MEDIA_MIME).flatMap((ext) => [`a.${ext}`, `A.${ext.toUpperCase()}`, `many.dots.${ext}`]),
      'dotless', 'imagepng', '.svg', 'clip.ts', 'clip.mp4.', 'clip.unsafe/mp4', 'clip.123456789', 'clip.pñg', '', 'clip.png\n'];
    const types = [null, '', GENERIC_CONTENT_TYPE, 'image/png', 'audio/ogg', 'video/mp2t', 'application/pdf', 'IMAGE/PNG',
      'application/octet-stream; charset=utf-8', 'image', 'audio', 'video', 'text/plain'];
    const add = db.prepare('INSERT INTO kinds VALUES (?, ?)');
    for (const filename of filenames) for (const contentType of types) add.run(contentType, filename);
    const rows = db.prepare(`SELECT content_type AS contentType, filename,
      ${attachmentKindSql('content_type', 'filename')} AS kind FROM kinds`).all() as { contentType: string | null; filename: string; kind: string }[];
    for (const row of rows) expect(row.kind, JSON.stringify(row)).toBe(mediaKind(row));
  });
});
