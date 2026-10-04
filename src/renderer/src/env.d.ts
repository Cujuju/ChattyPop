/// <reference types="vite/client" />
import type { RendererApi } from '@shared/contract';

declare global {
  interface Window {
    /** The preload's API; absent on a page a transport serves. Read only by `@/api`, which host code calls instead. */
    chattypop?: RendererApi;
  }
}
