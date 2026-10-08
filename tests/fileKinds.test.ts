import { describe, expect, it } from 'vitest';
import { fileKind, fileTypeLabel } from '@shared/fileKinds';

const kind = (filename: string, contentType: string | null = null) => fileKind({ contentType, filename });

describe('file kinds', () => {
  it('names each family Discord draws its own icon for, by ending', () => {
    expect(kind('report.PDF')).toBe('pdf');
    expect(kind('backup.tar.gz')).toBe('archive');
    expect(kind('budget.xlsx')).toBe('spreadsheet');
    expect(kind('data.csv', 'text/csv')).toBe('spreadsheet');
    expect(kind('deck.pptx')).toBe('slides');
    expect(kind('letter.docx')).toBe('document');
  });

  it('tells writing from source among text files', () => {
    expect(kind('message.txt', 'text/plain; charset=utf-8')).toBe('document');
    expect(kind('README.md')).toBe('document');
    expect(kind('build.log')).toBe('document');
    expect(kind('main.rs')).toBe('code');
    expect(kind('Dockerfile')).toBe('code');
  });

  it('keeps media kinds, with a text ending over a media content type as the log shows it', () => {
    expect(kind('logo.svg', 'image/svg+xml')).toBe('image');
    expect(kind('clip.mp4', 'video/mp4')).toBe('video');
    expect(kind('song.ogg', 'audio/ogg')).toBe('audio');
    expect(kind('main.ts', 'video/mp2t')).toBe('code');
  });

  it('labels the type by its ending, or by its kind when it has none', () => {
    const label = (filename: string) => fileTypeLabel({ contentType: null, filename });
    expect(label('a-very-long-name.tar.gz')).toBe('GZ');
    expect(label('server.rs')).toBe('RS');
    expect(label('Dockerfile')).toBe('Code');
    expect(label('.gitignore')).toBe('File');
    expect(label('trailing.')).toBe('File');
  });

  it('falls back to a plain file', () => {
    expect(kind('data.bin')).toBe('unknown');
    expect(kind('setup.exe', 'application/octet-stream')).toBe('unknown');
  });
});
