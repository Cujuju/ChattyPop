/** A path on this page's own origin; anything absolute is refused, so a page reaches only the server that served it. */
function samePath(path: string): string {
  if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`Not a path on this page's origin: ${path}`);
  return path;
}

/** Fetch to the server that served this page. */
export const pageFetch = (path: string, init?: RequestInit): Promise<Response> => fetch(samePath(path), init);

/** An event stream from the server that served this page. */
export const pageEvents = (path: string): EventSource => new EventSource(samePath(path));
