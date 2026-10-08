// The app asks and tells through its own themed dialogs (state/dialogs, ui/PromptDialog), never the browser's or the
// system's unthemed boxes.
import { createRequire } from 'node:module';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('solid-js', () => createRequire(import.meta.url)('solid-js/dist/solid.cjs') as Record<string, unknown>);

const { confirmDialog, failureNotice, noticeDialog, shownPrompt } = await import('../src/renderer/src/state/dialogs');

const SRC = resolve(__dirname, '../src');
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sources(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : [],
  );
const COMMENT_LINE = /^\s*(\/\/|\/\*|\*)/;
/** `file:line` for each code line (not a comment) of the files under `dirs` matching `pattern`. */
const offenders = (dirs: string[], pattern: RegExp): string[] =>
  dirs.flatMap(sources).flatMap((file) =>
    readFileSync(file, 'utf8')
      .split('\n')
      .flatMap((line, i) => (!COMMENT_LINE.test(line) && pattern.test(line) ? [`${relative(SRC, file)}:${i + 1}`] : [])),
  );

describe('themed dialogs only', () => {
  it('renderer code never calls the browser confirm, alert or prompt', () => {
    expect(offenders([join(SRC, 'renderer'), join(SRC, 'plugin-sdk')], /(?<![\w.$])(?:window\.)?(?:confirm|alert|prompt)\s*\(/)).toEqual([]);
  });

  it('main never shows a system message box', () => {
    expect(offenders([join(SRC, 'main')], /showMessageBox|showErrorBox/)).toEqual([]);
  });
});

describe('prompts', () => {
  it('show one at a time, in order, each answering its own caller', async () => {
    const first = confirmDialog({ title: 'Delete rule', message: 'Delete it?', confirmLabel: 'Delete', danger: true });
    const second = noticeDialog({ title: 'Done', message: 'It went.' });
    expect(shownPrompt()).toMatchObject({ title: 'Delete rule', confirmLabel: 'Delete', cancelLabel: 'Cancel', danger: true });
    shownPrompt()!.answer(true);
    expect(await first).toBe(true);
    expect(shownPrompt()).toMatchObject({ title: 'Done', confirmLabel: 'OK', cancelLabel: null });
    shownPrompt()!.answer(false); // Esc on a notice still just dismisses it
    await second;
    expect(shownPrompt()).toBeNull();
  });

  it('a cancelled confirmation answers false', async () => {
    const asked = confirmDialog({ title: 'Remove key', message: 'Remove it?', confirmLabel: 'Remove' });
    shownPrompt()!.answer(false);
    expect(await asked).toBe(false);
  });

  it('a failed action is told with its error text as the message', () => {
    failureNotice("Couldn't save a.png")(new Error('disk full'));
    expect(shownPrompt()).toMatchObject({ title: "Couldn't save a.png", message: 'disk full', cancelLabel: null });
    shownPrompt()!.answer(true);
  });
});
