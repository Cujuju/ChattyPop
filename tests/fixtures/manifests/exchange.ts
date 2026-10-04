// Import and export (Settings → Archive): DiscordChatExporter JSON in; DCE-compatible JSON or a standalone HTML page out.
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import type { ExchangeResult, ExportOptions, ExportRequest } from './types';

export const manifest = {
  id: 'exchange',
  name: 'Import and export',
  version: '1.0.0',
  description: 'Imports DiscordChatExporter JSON exports; exports channels as JSON or a standalone HTML page (Settings → Archive).',
};

/** Core's calls, from main once a file or folder is picked. */
export interface ExchangeCoreCalls {
  /** Archives each file's channel (opted in) and stores its messages. */
  importDce(paths: string[]): ExchangeResult;
  exportChannels(req: ExportRequest): ExchangeResult;
}

/** Main's calls, from Settings: each asks for files or a folder first; null when cancelled. */
export interface ExchangeMainCalls {
  importDce(): Promise<ExchangeResult | null>;
  exportChannels(opts: ExportOptions): Promise<ExchangeResult | null>;
}

/** Its section in Settings → Archive. */
export const EXCHANGE_SECTION = 'exchange' as const;

export const plugin = definePlugin({
  manifest,
  channels: defineChannels<{ core: ExchangeCoreCalls; main: ExchangeMainCalls }>()({
    core: { importDce: ['main'], exportChannels: ['main'] },
    main: { importDce: ['renderer'], exportChannels: ['renderer'] },
  }),
  settings: [{ id: EXCHANGE_SECTION, label: 'Export and import', page: 'archive' }],
});
export default plugin;
