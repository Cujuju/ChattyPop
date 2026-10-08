// An HTML export as a one-page PDF the size of its content, drawn by a hidden window that runs no script and loads nothing.
import { randomBytes } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, app, session, type Session } from 'electron';
import type { PdfSource } from '@shared/htmlPage';

/** CSS pixels per inch, as printToPDF measures pages. */
const CSS_PX_PER_INCH = 96;
/** The window's height while the page lays out; the PDF takes the content's own height. */
const LAYOUT_HEIGHT_PX = 800;
/** In-memory session (no `persist:`), so export pages share nothing with the app's or Discord's. */
const PARTITION = 'cp-pdf-export';
/** Random bytes in a temp page's name, so two exports never share a file. */
const NAME_BYTES = 8;
/** The Chrome DevTools Protocol version the debugger speaks. */
const CDP_VERSION = '1.3';
/** Colours and backgrounds print as shown, edge to edge: the page's own padding is its margin. */
const PRINT_CSS = '@page { margin: 0 } html { -webkit-print-color-adjust: exact; print-color-adjust: exact }';

/** The export pages being drawn: the only URLs the export session loads. */
const loading = new Set<string>();
let locked: Session | null = null;
/** The export session: every request but an export page itself is cancelled. */
function exportSession(): Session {
  if (locked) return locked;
  locked = session.fromPartition(PARTITION);
  locked.webRequest.onBeforeRequest((details, done) => done({ cancel: !loading.has(details.url) }));
  locked.setPermissionRequestHandler((_wc, _permission, done) => done(false));
  return locked;
}

/**
 * `source.html` laid out `source.width` CSS px wide, as one PDF page its full height.
 * Residual: some PDF viewers cap a page side at 200 in (19,200 px) and shrink taller pages.
 */
export async function htmlToPdf(source: PdfSource): Promise<Uint8Array> {
  const file = join(app.getPath('temp'), `chattypop-export-${randomBytes(NAME_BYTES).toString('hex')}.html`);
  const url = pathToFileURL(file).href;
  await writeFile(file, source.html, 'utf8');
  loading.add(url);
  const win = new BrowserWindow({
    show: false,
    width: source.width,
    height: LAYOUT_HEIGHT_PX,
    useContentSize: true,
    webPreferences: { session: exportSession(), javascript: false, sandbox: true, contextIsolation: true, spellcheck: false },
  });
  try {
    const wc = win.webContents;
    // A link in the page opens nothing.
    wc.setWindowOpenHandler(() => ({ action: 'deny' }));
    wc.on('will-navigate', (e) => e.preventDefault());
    await win.loadURL(url);
    await wc.insertCSS(PRINT_CSS);
    wc.debugger.attach(CDP_VERSION);
    // Measured as printed: print layout can run taller than the screen's, and a page shorter than its content breaks onto a second.
    await wc.debugger.sendCommand('Emulation.setEmulatedMedia', { media: 'print' });
    const metrics = (await wc.debugger.sendCommand('Page.getLayoutMetrics')) as { cssContentSize: { width: number; height: number } };
    wc.debugger.detach();
    const width = Math.ceil(Math.max(metrics.cssContentSize.width, source.width));
    const height = Math.ceil(metrics.cssContentSize.height);
    return await wc.printToPDF({
      printBackground: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      pageSize: { width: width / CSS_PX_PER_INCH, height: height / CSS_PX_PER_INCH },
    });
  } finally {
    win.destroy();
    loading.delete(url);
    await rm(file, { force: true });
  }
}
