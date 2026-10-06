// Required command options start with pills; optional options are added by name. Valid text and numbers accept typing; other values require picks. Blocking options prevent execution.
import { describe, expect, it, vi } from 'vitest';
import { OPTION, type CommandEntry, type CommandOption } from '@shared/commands';

vi.mock('../src/renderer/src/state/commands', () => ({ interactionGuild: (g: string) => g, followOutcome: () => undefined }));
vi.mock('../src/renderer/src/state/localCommands', () => ({ runLocalCommand: async () => undefined }));

const { entityQuery, listedChoices, optionalLeft, picksFromList, typedValue } = await import('../src/renderer/src/state/commandOptions');

interface Filled {
  value: string | number | boolean;
  label: string;
}
/** Path import keeps the renderer’s DOM types outside node type checking. */
interface DraftModule {
  startCommand(channelId: string, entry: CommandEntry): void;
  commandDraft(channelId: string): { shown: string[]; texts: Record<string, string>; values: Record<string, Filled> } | undefined;
  addOption(channelId: string, name: string): void;
  setCommandTail(channelId: string, text: string): void;
  removeOption(channelId: string, name: string): void;
  setOptionText(channelId: string, o: CommandOption, text: string): void;
  pickOption(channelId: string, name: string, filled: Filled): void;
  missingOptions(channelId: string): CommandOption[];
  unfinishedOptions(channelId: string): CommandOption[];
  commandReady(channelId: string): boolean;
  runCommand(channelId: string, guildId: string): Promise<void>;
}
const draftPath = '../src/renderer/src/state/commandDraft';
const draft = (await import(draftPath)) as DraftModule;

const option = (over: Partial<CommandOption> & Pick<CommandOption, 'name' | 'type'>): CommandOption => ({
  description: '',
  required: false,
  choices: [],
  autocomplete: false,
  options: [],
  channelTypes: [],
  minValue: null,
  maxValue: null,
  minLength: null,
  maxLength: null,
  ...over,
});

const WHEN = option({ name: 'when', type: OPTION.string, required: true, minLength: 2 });
const COUNT = option({ name: 'count', type: OPTION.integer, required: true, minValue: 1, maxValue: 10 });
const UNIT = option({ name: 'unit', type: OPTION.string, choices: [{ name: 'Minutes', value: 'm' }, { name: 'Hours', value: 'h' }] });
const LOUD = option({ name: 'loud', type: OPTION.boolean });
const WHO = option({ name: 'who', type: OPTION.user });
const FILE = option({ name: 'file', type: OPTION.attachment });

const entry = (options: CommandOption[]): CommandEntry => ({
  command: { id: '1', applicationId: '2', version: '3', name: 'remind', description: '', options, type: 1 } as unknown as CommandEntry['command'],
  path: [],
  fullName: 'remind',
  description: 'Set a reminder',
  options,
});

describe('command options', () => {
  it('takes typed text as the value only when it is valid for a text or number option', () => {
    expect(typedValue(WHEN, 'x')).toBeNull(); // shorter than minLength
    expect(typedValue(WHEN, 'soon')).toEqual({ value: 'soon', label: 'soon' });
    expect(typedValue(COUNT, '3')).toEqual({ value: 3, label: '3' });
    expect(typedValue(COUNT, '2.5')).toBeNull();
    expect(typedValue(COUNT, '11')).toBeNull();
    expect(typedValue(COUNT, ' ')).toBeNull();
    for (const o of [UNIT, LOUD, WHO, FILE]) expect(typedValue(o, 'Hours')).toBeNull();
    expect([UNIT, LOUD, WHO].every(picksFromList)).toBe(true);
    expect(picksFromList(WHEN)).toBe(false);
  });

  it('lists choices and True/False narrowed by what is typed', () => {
    expect(listedChoices(UNIT, '').map((c) => c.label)).toEqual(['Minutes', 'Hours']);
    expect(listedChoices(UNIT, 'hou')).toEqual([{ value: 'h', label: 'Hours' }]);
    expect(listedChoices(LOUD, 'f')).toEqual([{ value: false, label: 'False' }]);
  });

  it('offers optional options not yet in the bar, by name; searches without the @ or # sigil', () => {
    const all = [WHEN, COUNT, UNIT, LOUD, WHO];
    expect(optionalLeft(all, ['when', 'count', 'loud'], '').map((o) => o.name)).toEqual(['unit', 'who']);
    expect(optionalLeft(all, [], 'wh').map((o) => o.name)).toEqual(['who']);
    expect(entityQuery('@ann')).toBe('ann');
    expect(entityQuery('#general')).toBe('general');
  });
});

describe('command draft', () => {
  const CH = 'c1';

  it('starts with pills for the required options; optional ones are added and dropped with their values', () => {
    draft.startCommand(CH, entry([WHEN, UNIT, COUNT, LOUD]));
    expect(draft.commandDraft(CH)!.shown).toEqual(['when', 'count']);
    draft.addOption(CH, 'loud');
    draft.addOption(CH, 'loud');
    draft.addOption(CH, 'nope');
    expect(draft.commandDraft(CH)!.shown).toEqual(['when', 'count', 'loud']);
    draft.pickOption(CH, 'loud', { value: true, label: 'True' });
    draft.removeOption(CH, 'loud');
    draft.removeOption(CH, 'when'); // required: stays
    expect(draft.commandDraft(CH)!.shown).toEqual(['when', 'count']);
    expect(draft.commandDraft(CH)!.values).toEqual({});
  });

  it('is ready only with every required option filled and no pill holding text that is not a value', () => {
    draft.startCommand(CH, entry([WHEN, UNIT, COUNT]));
    expect(draft.missingOptions(CH).map((o) => o.name)).toEqual(['when', 'count']);
    draft.setOptionText(CH, WHEN, 'soon');
    draft.setOptionText(CH, COUNT, '99');
    expect(draft.commandReady(CH)).toBe(false);
    expect(draft.unfinishedOptions(CH).map((o) => o.name)).toEqual(['count']);
    draft.setOptionText(CH, COUNT, '5');
    expect(draft.commandReady(CH)).toBe(true);
    // Typed into a choice option without picking: it blocks until a choice is picked.
    draft.addOption(CH, 'unit');
    draft.setOptionText(CH, UNIT, 'Hou');
    expect(draft.commandReady(CH)).toBe(false);
    draft.pickOption(CH, 'unit', { value: 'h', label: 'Hours' });
    expect(draft.commandDraft(CH)!.texts['unit']).toBe('Hours');
    expect(draft.commandReady(CH)).toBe(true);
    // Editing a picked pill clears its value.
    draft.setOptionText(CH, UNIT, 'Hour');
    expect(draft.commandDraft(CH)!.values['unit']).toBeUndefined();
  });

  it('runs with the filled values, typed as their options, and clears; refuses while something blocks', async () => {
    const runCommand = vi.fn(async () => ({ kind: 'done' }));
    vi.stubGlobal('window', { chattypop: { discord: { runCommand } } });
    try {
      draft.startCommand(CH, entry([WHEN, COUNT, UNIT]));
      draft.setOptionText(CH, WHEN, 'soon');
      await expect(draft.runCommand(CH, 'g1')).rejects.toThrow(/count/);
      draft.setOptionText(CH, COUNT, '4');
      // Text left at the bar's end names no option: it blocks until used or cleared.
      draft.setCommandTail(CH, 'message:');
      expect(draft.commandReady(CH)).toBe(false);
      await expect(draft.runCommand(CH, 'g1')).rejects.toThrow(/message:/);
      draft.addOption(CH, 'unit');
      draft.pickOption(CH, 'unit', { value: 'm', label: 'Minutes' });
      await draft.runCommand(CH, 'g1');
      expect(runCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          values: [
            { name: 'when', type: OPTION.string, value: 'soon' },
            { name: 'count', type: OPTION.integer, value: 4 },
            { name: 'unit', type: OPTION.string, value: 'm' },
          ],
          files: [],
        }),
      );
      expect(draft.commandDraft(CH)).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
