import { dialog, ipcMain, type BrowserWindow } from 'electron';
import { MAIN_INVOKE } from '@shared/contract';
import { RULE_FILE_EXTENSIONS, type RuleFileFormat } from '@shared/ruleKinds/host';

const FORMAT_NAMES: Readonly<Record<RuleFileFormat, string>> = { markdown: 'Markdown', jsonl: 'JSON Lines' };

const isFormat = (v: unknown): v is RuleFileFormat => typeof v === 'string' && Object.hasOwn(RULE_FILE_EXTENSIONS, v);

/** Settings → Rules requests main serves: picking the file a rule's file action appends to. */
export function registerRuleHandlers(win: BrowserWindow): void {
  ipcMain.handle(MAIN_INVOKE.rules.pickFile, async (_e, format: unknown) => {
    if (!isFormat(format)) throw new Error('Not a file format.');
    // An open dialog, not a save one: the file is appended to, so picking an existing one must not ask to replace it.
    const pick = await dialog.showOpenDialog(win, {
      title: 'File for this rule to add messages to',
      properties: ['openFile', 'promptToCreate'],
      filters: [{ name: FORMAT_NAMES[format], extensions: RULE_FILE_EXTENSIONS[format].map((ext) => ext.slice(1)) }],
    });
    return (!pick.canceled && pick.filePaths[0]) || null;
  });
}
