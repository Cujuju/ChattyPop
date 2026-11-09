import { describe, expect, it } from 'vitest';
import { closeFromCode, closeFromOwner, takeCodeClose, takeOwnerClose } from '../src/main/windowClose';

describe('window close intent', () => {
  it('distinguishes code and owner closes and consumes owner intent once', () => {
    const intents: boolean[][] = [];
    const win = { close: () => intents.push([takeOwnerClose(win as unknown as Electron.BrowserWindow), takeCodeClose(win as unknown as Electron.BrowserWindow)]) };
    closeFromOwner(win as unknown as Electron.BrowserWindow);
    closeFromCode(win as unknown as Electron.BrowserWindow);
    expect(intents).toEqual([[true, false], [false, true]]);
    expect(takeOwnerClose(win as unknown as Electron.BrowserWindow)).toBe(false);
  });
  it('retains owner intent until the close event consumes it', () => {
    const win = { close: () => {} } as unknown as Electron.BrowserWindow;
    closeFromOwner(win);
    expect(takeOwnerClose(win)).toBe(true);
    expect(takeOwnerClose(win)).toBe(false);
  });
});
