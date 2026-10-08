// An HTML export as the renderer hands it on: saved on the desktop, opened in a phone's browser (PhoneTransport.openPage).
export interface HtmlPage {
  /** A whole self-contained document. */
  html: string;
  /** The saved file's name, `.html` included. */
  fileName: string;
}
