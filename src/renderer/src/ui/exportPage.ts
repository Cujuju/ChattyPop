// Exports: the desktop saves the file; a phone whose transport can opens it in the device's browser, the PDF drawn by the desktop.
import type { ExportFormat, HtmlPage, PdfPage } from '@shared/htmlPage';
import { api } from '@/api';

export type { HtmlPage, PdfPage };

const HTML_TYPE = 'text/html;charset=utf-8';

/** The phone transport's opener (PhoneTransport.openExport, else openPage); null on the desktop and on transports without one. */
type Opener = (page: Promise<HtmlPage | PdfPage>, format: ExportFormat) => void;
let opener: Opener | null = null;
export const setPageOpener = (open: Opener | null): void => void (opener = open);

/** Delivers `page`: opened in the phone's browser, else downloaded (the desktop asks where to save it). Call within the tap that asked. */
export async function exportHtmlPage(page: HtmlPage | Promise<HtmlPage>): Promise<void> {
  if (opener) return opener(Promise.resolve(page), 'html');
  const { html, fileName } = await page;
  const url = URL.createObjectURL(new Blob([html], { type: HTML_TYPE }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  a.click();
  // After the click's task, once the download has the file.
  setTimeout(() => URL.revokeObjectURL(url));
}

/** Delivers `page` as a one-page PDF the desktop draws: opened in the phone's browser, else saved where the desktop asks. Call within the tap that asked. */
export async function exportPdfPage(page: PdfPage | Promise<PdfPage>): Promise<void> {
  if (opener) return opener(Promise.resolve(page), 'pdf');
  await api.media.savePdf(await page);
}
