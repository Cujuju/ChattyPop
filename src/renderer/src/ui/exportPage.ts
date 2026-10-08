// An HTML export: the desktop saves it as a file; a phone whose transport can opens it in the device's browser.
import type { HtmlPage } from '@shared/htmlPage';

export type { HtmlPage };

const HTML_TYPE = 'text/html;charset=utf-8';

/** The phone transport's opener (PhoneTransport.openPage); null on the desktop and on transports without one. */
let opener: ((page: HtmlPage) => void) | null = null;
export const setPageOpener = (open: ((page: HtmlPage) => void) | null): void => void (opener = open);

/** Delivers `page`: opened in the phone's browser, else downloaded (the desktop asks where to save it). Call within the tap that asked. */
export function exportHtmlPage(page: HtmlPage): void {
  if (opener) return opener(page);
  const url = URL.createObjectURL(new Blob([page.html], { type: HTML_TYPE }));
  const a = document.createElement('a');
  a.href = url;
  a.download = page.fileName;
  a.click();
  // After the click's task, once the download has the file.
  setTimeout(() => URL.revokeObjectURL(url));
}
