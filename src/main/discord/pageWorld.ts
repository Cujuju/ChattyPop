// Scripts in the Discord page run in an isolated world: they share its DOM, never its globals or its patched builtins.
import type { WebContents } from 'electron';

/** CDP's name for the world; only the inspector sees it. */
const WORLD_NAME = 'isolated';
/** CDP's answer for a context id from a document since replaced: nothing ran, so asking again is safe. */
const STALE_CONTEXT = /Cannot find context with specified id/;

type Page = Pick<WebContents, 'debugger' | 'on'>;

interface Evaluated {
  result: { value?: unknown };
  exceptionDetails?: { text: string; exception?: { description?: string } };
}

/** The isolated world in the page's main frame; created per document on first use, through the tap's debugger. */
export class PageWorld {
  private context: Promise<number> | null = null;

  constructor(private readonly page: Page) {
    // A new document has new contexts.
    page.on('did-navigate', () => (this.context = null));
  }

  /** Runs `expression` in the world and resolves with its (awaited) value; rejects with what it threw. */
  async evaluate<T>(expression: string): Promise<T> {
    try {
      return await this.run<T>(expression);
    } catch (err) {
      if (!(err instanceof Error) || !STALE_CONTEXT.test(err.message)) throw err;
      this.context = null;
      return this.run<T>(expression);
    }
  }

  private async run<T>(expression: string): Promise<T> {
    const contextId = await (this.context ??= this.create());
    const r = (await this.page.debugger.sendCommand('Runtime.evaluate', { expression, contextId, awaitPromise: true, returnByValue: true })) as Evaluated;
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value as T;
  }

  private async create(): Promise<number> {
    try {
      const tree = (await this.page.debugger.sendCommand('Page.getFrameTree')) as { frameTree: { frame: { id: string } } };
      const world = (await this.page.debugger.sendCommand('Page.createIsolatedWorld', { frameId: tree.frameTree.frame.id, worldName: WORLD_NAME })) as { executionContextId: number };
      return world.executionContextId;
    } catch (err) {
      this.context = null;
      throw err;
    }
  }
}
