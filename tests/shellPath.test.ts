// A packaged app on macOS or Linux takes the owner's shell PATH, so the tools it runs are found.
import { delimiter } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({ app: { isPackaged: false, getPath: () => '' } }));
vi.mock('../src/main/diagnostics', () => ({ diag: () => undefined }));

const { commonToolDirs, mergedPath, pathFromShellOutput } = await import('../src/main/shellPath');

const MARK = '__CHATTYPOP_PATH__';
const path = (...dirs: string[]): string => dirs.join(delimiter);

describe('shell PATH (main)', () => {
  it('reads the PATH between the marks, past what startup files print', () => {
    expect(pathFromShellOutput(`motd\n${MARK}\n/a/bin:/b/bin\n${MARK}\nbye\n`)).toBe('/a/bin:/b/bin');
    expect(pathFromShellOutput('no marks here')).toBeNull();
    expect(pathFromShellOutput(`${MARK}\n\n${MARK}\n`)).toBeNull();
  });

  it('puts the shell’s folders first, then the app’s own, then the fallback, each once', () => {
    expect(mergedPath(path('/usr/bin', '/bin'), path('/opt/tools/bin', '/usr/bin'), ['/usr/local/bin', '/bin'])).toBe(
      path('/opt/tools/bin', '/usr/bin', '/bin', '/usr/local/bin'),
    );
  });

  it('keeps the app’s PATH and the fallback when the shell can’t say', () => {
    expect(mergedPath(path('/usr/bin'), null, ['/usr/local/bin'])).toBe(path('/usr/bin', '/usr/local/bin'));
  });

  it('drops relative and empty entries, which would search the working folder', () => {
    expect(mergedPath(path('', '.', '/usr/bin'), path('bin', '/opt/bin'), [])).toBe(path('/opt/bin', '/usr/bin'));
  });

  it('names Homebrew, /usr/local and the per-user folder as the fallback', () => {
    expect(commonToolDirs('/Users/x')).toEqual(['/opt/homebrew/bin', '/usr/local/bin', '/Users/x/.local/bin']);
  });
});
