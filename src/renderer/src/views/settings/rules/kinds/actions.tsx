// Host action editors and collapsed-card summaries.
import { RuleLookback as Lookback } from '../RuleLookback';
import { ACTION_LOOKBACKS } from '@shared/rules';
import { RULE_FILE_EXTENSIONS, type RuleFileFormat } from '@shared/ruleKinds/host';
import type { FileConfig, CommandConfig } from '@shared/ruleKinds/host';
import { plugins } from '@/state/plugins';
import { pickRuleFile } from '@/state/rules';
import { createAction } from '@/ui/action';
import { Select } from '@/ui/Select';
import { ErrorNote, Row, settingsControl as c } from '@/views/settings/SettingsLayout';
import type { KindProps, KindView } from './types';

const FORMAT_OPTIONS: { value: RuleFileFormat; label: string }[] = [
  { value: 'markdown', label: 'Markdown (a line per message)' },
  { value: 'jsonl', label: 'JSON Lines (one object per message)' },
];
/** Joins a plugin id and command id into one picker value; neither can hold a NUL. */
const PLUGIN_COMMAND_SEP = '\u0000';

function FileEditor(props: KindProps<FileConfig>) {
  const id = (field: string) => `${props.id}-${field}`;
  const set = (patch: Partial<FileConfig>) => props.onChange({ ...props.config, ...patch });
  const picking = createAction();
  const pickFile = async (a: FileConfig): Promise<void> => {
    const path = await picking.run(() => pickRuleFile(a.format));
    if (path) set({ path });
  };
  return (
    <>
      <Row
        label="File"
        for={id('path')}
        hint={`Full path ending in ${RULE_FILE_EXTENSIONS[props.config.format].join(', ')}; created if missing, appended each run.`}
        control={
          <button type="button" class="cp-button" disabled={picking.busy()} onClick={() => void pickFile(props.config)}>
            Choose…
          </button>
        }
      >
        <input
          id={id('path')}
          class={c.wide}
          type="text"
          value={props.config.path}
          onInput={(e) => set({ path: e.currentTarget.value })}
        />
        <ErrorNote error={picking.error()} />
      </Row>
      <Row
        label="Format"
        for={id('format')}
        control={
          <Select
            id={id('format')}
            class={c.select}
            value={props.config.format}
            options={FORMAT_OPTIONS}
            onChange={(f) => set({ format: f as RuleFileFormat })}
          />
        }
      />
    </>
  );
}
function CommandEditor(props: KindProps<CommandConfig>) {
  const id = (field: string) => `${props.id}-${field}`;
  const set = (patch: Partial<CommandConfig>) => props.onChange({ ...props.config, ...patch });
  return (
    <>
      <Row
        label="Command"
        for={id('command')}
        control={
          <Select
            id={id('command')}
            class={c.select}
            value={
              props.config.pluginId ? `${props.config.pluginId}${PLUGIN_COMMAND_SEP}${props.config.commandId}` : ''
            }
            options={[
              { value: '', label: 'Pick a command' },
              ...plugins().flatMap((p) =>
                p.commands.map((cmd) => ({
                  value: `${p.id}${PLUGIN_COMMAND_SEP}${cmd.id}`,
                  label: `${p.name}: ${cmd.title}`,
                })),
              ),
            ]}
            onChange={(v) => {
              const [pluginId = '', commandId = ''] = v ? v.split(PLUGIN_COMMAND_SEP) : [];
              set({ pluginId, commandId });
            }}
          />
        }
      />
      <Lookback {...props} />
    </>
  );
}

const lookbackLabel = (ms: number): string => ACTION_LOOKBACKS.find((l) => l.ms === ms)?.label ?? '';

function commandSummary(a: CommandConfig, cover?: string): string {
  const p = plugins().find((x) => x.id === a.pluginId);
  const cmd = p?.commands.find((c) => c.id === a.commandId);
  return p && cmd
    ? `${p.name}: ${cmd.title} · ${(cover ?? lookbackLabel(a.lookbackMs)).toLowerCase()}`
    : 'Pick a command';
}
const view = <C,>(v: KindView<C>): KindView => v as KindView;
/** Each action’s fields, window hint and collapsed-card summary. */
export const actionViews: Record<string, KindView> = {
  file: view({ Editor: FileEditor, summary: (c) => (c.path.trim() ? c.path.split(/[\\/]/).pop()! : 'Pick a file') }),
  command: view({
    windowHint: "Runs a plugin command over the rule's channels for the time it covers.",
    Editor: CommandEditor,
    summary: (c, cover) => commandSummary(c, cover),
  }),
};
