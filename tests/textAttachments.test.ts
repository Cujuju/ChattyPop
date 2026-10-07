import { describe, expect, it } from 'vitest';
import { attachmentView } from '@shared/media';
import { isTextFile, textExtension } from '@shared/textFiles';
import { PLAIN_LANGUAGE, highlightLines, languageFor } from '../src/renderer/src/ui/highlight';

const stored = (filename: string, contentType: string | null = null) => attachmentView({ status: 'stored', contentType, filename });

describe('text attachments', () => {
  it('previews by the last ending, whatever the case, as Discord does', () => {
    expect(isTextFile('notes.txt')).toBe(true);
    expect(isTextFile('build.LOG')).toBe(true);
    expect(isTextFile('archive.tar.gz')).toBe(false);
    expect(isTextFile('Dockerfile')).toBe(true);
    expect(textExtension('a.b.c++')).toBe('c++');
  });

  it('shows a text ending as text over any kind but image', () => {
    expect(stored('message.txt', 'text/plain; charset=utf-8')).toBe('text');
    expect(stored('main.ts', 'video/mp2t')).toBe('text');
    expect(stored('logo.svg', 'image/svg+xml')).toBe('image');
    expect(stored('clip.mp4', 'video/mp4')).toBe('video');
    expect(stored('data.bin')).toBe('file');
    expect(attachmentView({ status: 'pending', contentType: 'text/plain', filename: 'message.txt' })).toBe('file');
  });

  it('picks a grammar by ending or alias, else plain text', () => {
    expect(languageFor('ts')).toBe('typescript');
    expect(languageFor('py')).toBe('python');
    expect(languageFor('txt')).toBe(PLAIN_LANGUAGE);
  });

  it('colors code with --cp-code-* tokens, so the theme owns the palette', async () => {
    const lines = await highlightLines('const a = "b";\n// c', 'typescript');
    expect(lines).toHaveLength(2);
    const colors = lines.flat().map((t) => t.color);
    expect(colors.length).toBeGreaterThan(0);
    expect(colors.every((c) => c?.startsWith('var(--cp-code-'))).toBe(true);
  });

  it('keeps plain text as written, one run per line', async () => {
    expect(await highlightLines('a\nb', PLAIN_LANGUAGE)).toEqual([[{ content: 'a', offset: 0 }], [{ content: 'b', offset: 0 }]]);
  });
});
