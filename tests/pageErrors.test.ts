import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PAGE_ERROR_CHANNEL } from '@shared/contract';
import { PAGE_ERROR_MESSAGE_CHARACTERS, PAGE_ERROR_STACK_CHARACTERS, PAGE_ERRORS_PER_LOAD, pageError, type PageError } from '@shared/pageErrors';

const REPORTER_PATH = '../src/plugin-sdk/renderer/errorReporter.ts';
const { errorReporter } = await import(REPORTER_PATH);
const { on, handleMain, diag } = vi.hoisted(() => ({ on: vi.fn(), handleMain: vi.fn(), diag: vi.fn() }));
vi.mock('electron', () => ({ ipcMain: { on } }));
vi.mock('../src/main/ipc/mainCalls', () => ({ handleMain }));
vi.mock('../src/main/diagnostics', async (original) => ({ ...await original<object>(), diag }));
const { registerPageErrors } = await import('../src/main/pageErrors');

const PAGE = '12345678-1234-1234-1234-123456789abc';
const AT = 42;
const REPORT: PageError = { page: PAGE, at: AT, kind: 'error', message: 'TypeError: boom', stack: 'TypeError: boom\n    at f (x.ts:1:1)' };
const INVALID_PAGES = ['123456789012345678------------------', PAGE.replace('-', 'a'), PAGE.toUpperCase(), `${PAGE}\n`];

beforeEach(() => vi.clearAllMocks());

describe('page error contract', () => {
  it.each(INVALID_PAGES)('rejects a noncanonical page id %j', (page) => {
    expect(pageError({ ...REPORT, page })).toBeNull();
  });
  it('drops unknown fields and rejects invalid or unbounded reports', () => {
    expect(pageError({ ...REPORT, extra: 'dropped' })).toEqual(REPORT);
    for (const value of [null, 'error', {}, { ...REPORT, page: 'invalid' }, { ...REPORT, at: -1 }, { ...REPORT, at: NaN },
      { ...REPORT, kind: 'other' }, { ...REPORT, message: 'm'.repeat(PAGE_ERROR_MESSAGE_CHARACTERS + 1) },
      { ...REPORT, stack: 's'.repeat(PAGE_ERROR_STACK_CHARACTERS + 1) }]) expect(pageError(value)).toBeNull();
  });
});

describe('main page diagnostics', () => {
  it('rejects noncanonical page ids before logging', () => {
    const sender = {};
    registerPageErrors((candidate) => candidate === sender ? 'main' : undefined);
    for (const page of INVALID_PAGES) {
      const report = { ...REPORT, page };
      on.mock.calls[0]![1]({ sender }, report);
    }
    expect(diag).not.toHaveBeenCalled();
  });
  it('names local windows from their sender, redacts ids and drops invalid reports', () => {
    const main = {}, panel = {}, unknown = {};
    registerPageErrors((sender) => sender === main ? 'main' : sender === panel ? 'panel:probe' : undefined);
    const local = on.mock.calls[0]![1];
    expect(on.mock.calls[0]![0]).toBe(PAGE_ERROR_CHANNEL);
    expect(handleMain).not.toHaveBeenCalled();
    const report = { ...REPORT, message: 'Missing 123456789012345678', stack: 'at /channels/987654321098765432', window: 'forged' };
    local({ sender: main }, report);
    local({ sender: panel }, report);
    expect(diag.mock.calls).toEqual(['main', 'panel:probe'].map((window) => [
      'page-error', { ...REPORT, window, message: 'Missing :id', stack: 'at /channels/:id' },
    ]));
    local({ sender: unknown }, report);
    local({ sender: main }, { ...REPORT, kind: 'other' });
    local({ sender: main }, { ...REPORT, message: 'm'.repeat(PAGE_ERROR_MESSAGE_CHARACTERS + 1) });
    expect(diag).toHaveBeenCalledTimes(2);
  });
});

describe('page error reporter', () => {
  /** A window's listeners, fired by name. */
  function source() {
    const listeners = new Map<string, (event: unknown) => void>();
    return {
      addEventListener: (name: string, listener: (event: unknown) => void) => void listeners.set(name, listener),
      fire: (name: string, event: unknown) => listeners.get(name)!(event),
    };
  }

  it('reports an uncaught error and an unhandled rejection, cut to the wire caps', () => {
    const send = vi.fn((_report: PageError) => Promise.resolve());
    const page = source();
    errorReporter(page, () => AT, send, PAGE);
    const thrown = new TypeError('m'.repeat(PAGE_ERROR_MESSAGE_CHARACTERS));
    thrown.stack = 's'.repeat(PAGE_ERROR_STACK_CHARACTERS + 1);
    page.fire('error', { error: thrown, message: 'ignored' });
    page.fire('error', { error: undefined, message: 'Script error.' });
    page.fire('unhandledrejection', { reason: 'refused' });
    expect(send.mock.calls.map(([report]) => report)).toEqual([
      { page: PAGE, at: AT, kind: 'error', message: `TypeError: ${'m'.repeat(PAGE_ERROR_MESSAGE_CHARACTERS)}`.slice(0, PAGE_ERROR_MESSAGE_CHARACTERS), stack: 's'.repeat(PAGE_ERROR_STACK_CHARACTERS) },
      { page: PAGE, at: AT, kind: 'error', message: 'Script error.', stack: '' },
      { page: PAGE, at: AT, kind: 'rejection', message: 'refused', stack: '' },
    ]);
  });

  it('stops at the per-load limit and survives a failed send', () => {
    const send = vi.fn(() => Promise.reject(new Error('offline')));
    const page = source();
    errorReporter(page, () => AT, send, PAGE);
    for (let i = 0; i <= PAGE_ERRORS_PER_LOAD; i++) page.fire('error', { error: new Error('again'), message: '' });
    expect(send).toHaveBeenCalledTimes(PAGE_ERRORS_PER_LOAD);
  });
});
