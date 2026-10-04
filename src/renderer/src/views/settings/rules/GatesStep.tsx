// Rule trigger selection, message gates and Discord permissions.
import { Dynamic } from 'solid-js/web';
import { For, Show, createResource, createSignal } from 'solid-js';
import { SegButton, SegGroup } from '@cujuju/solidjs-seg-buttons';
import { MESSAGE_TRIGGER } from '@shared/ruleKinds/host';
import { ruleKind, ruleKinds } from '@shared/ruleKinds';
import { actsAsYou, type Rule, type RuleGates, type RuleInput, type RuleSpec, type RuleTrigger } from '@shared/rules';
import { findPeople, peopleByIds } from '@/state/rules';
import { actsAsYouNotes, kindOffered } from '@/plugins/slots';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { triggerView } from './kinds';
import { Checks, Field, Step, listOrUndefined, type CheckItem } from './fields';
import { AddPicker, ChipRow, type PickOption } from './pickers';
import { PlacePicker } from '../PlacePicker';
import styles from './Rules.module.css';

type Who = 'anyone' | 'only' | 'but';
type Which = 'edited' | 'missed';
/** People offered per search. */
const PEOPLE_SHOWN = 20;

/** When: what starts the rule, where, who, which messages, and permission to post as the owner. */
export function GatesStep(props: {
  input: RuleInput;
  rule: Rule | null;
  onSpec: (patch: Partial<RuleSpec>) => void;
  onDiscordSend: (on: boolean) => void;
}) {
  const spec = () => props.input.spec;
  const gates = () => spec().gates;
  const setGates = (patch: Partial<RuleGates>): void => props.onSpec({ gates: { ...gates(), ...patch } });

  const timed = () => ruleKind('triggers', spec().trigger.type)?.event === 'window';
  const options = () => [
    ...(!ruleKind('triggers', spec().trigger.type)
      ? [{ value: spec().trigger.type, label: spec().trigger.type, type: spec().trigger.type, create: () => spec().trigger.config }]
      : []),
    ...ruleKinds('triggers').filter((k) => kindOffered(k.type) || k.type === spec().trigger.type).flatMap((k) =>
      (triggerView(k.type)?.choices ?? [{ value: k.type, label: k.label, create: k.create }]).map((choice) => ({
        ...choice,
        type: k.type,
      })),
    ),
  ];
  const selected = () => triggerView(spec().trigger.type)?.choice?.(spec().trigger.config) ?? spec().trigger.type;
  const setTrigger = (trigger: RuleTrigger): void => {
    // A timed rule acts on a stretch of time; message matches and author gates no longer apply.
    if (ruleKind('triggers', trigger.type)?.event === 'window')
      return props.onSpec({
        trigger,
        match: [],
        narrow: [],
        gates: { ...gates(), authorIds: undefined, authorsNot: undefined, edits: false, missed: false },
      });
    // Jev matching and edits require the message trigger; switching away removes those settings.
    props.onSpec({
      trigger,
      match: spec().match.filter((p) => trigger.type === MESSAGE_TRIGGER || !ruleKind('match', p.type)?.asksJev),
      gates: { ...gates(), edits: trigger.type === MESSAGE_TRIGGER && gates().edits },
    });
  };
  const pickTrigger = (value: string): void => {
    if (value === selected()) return;
    const choice = options().find((o) => o.value === value);
    if (choice) setTrigger({ type: choice.type, config: choice.create() });
  };

  // "Only"/"Anyone but" with nobody picked still means anyone; held here until the first person.
  const [pendingWho, setPendingWho] = createSignal<Who>('anyone');
  const who = (): Who => (gates().authorIds?.length ? (gates().authorsNot ? 'but' : 'only') : pendingWho());
  const chooseWho = (w: Who): void => {
    setPendingWho(w);
    if (w === 'anyone') setGates({ authorIds: undefined, authorsNot: undefined });
    else setGates({ authorsNot: w === 'but' || undefined });
  };
  const removePerson = (id: string): void => {
    setPendingWho(who()); // removing the last person keeps "Only" / "Anyone but" chosen
    setGates({ authorIds: listOrUndefined((gates().authorIds ?? []).filter((x) => x !== id)) });
  };
  const [people] = createResource(() => gates().authorIds ?? [], peopleByIds, { initialValue: [] });
  const personName = (id: string): string => people().find((p) => p.id === id)?.name ?? id;
  const searchPeople = async (q: string): Promise<PickOption[]> =>
    (await findPeople(q, PEOPLE_SHOWN))
      .filter((p) => !gates().authorIds?.includes(p.id))
      .map((p) => ({ value: p.id, label: p.name, hint: p.username ?? undefined }));

  const which = (): Which[] => [
    ...(gates().edits ? ['edited' as const] : []),
    ...(gates().missed ? ['missed' as const] : []),
  ];
  const whichItems = (): CheckItem<Which>[] => [
    ...(spec().trigger.type === MESSAGE_TRIGGER
      ? [
          { id: 'edited' as const, label: 'Edits' },
        ]
      : []),
    { id: 'missed', label: 'Missed while closed' },
  ];

  const posts = (): boolean => spec().actions.some(actsAsYou);

  return (
    <Step title="When">
      <div class={styles.card}>
        <Show when={!props.rule?.builtin}>
          <Field label="Starts on">
            <Select value={selected()} label="What starts the rule" options={options()} onChange={pickTrigger} />
          </Field>
        </Show>
        <Dynamic
          component={triggerView(spec().trigger.type)?.Editor}
          id={`rule-${props.rule?.id ?? 'new'}-trigger`}
          config={spec().trigger.config}
          onChange={(config: unknown) => props.onSpec({ trigger: { ...spec().trigger, config } })}
        />
        <Field label="Where" hint={gates().guildIds?.length || gates().channelIds?.length ? undefined : 'Every archived channel'}>
          <PlacePicker
            places={{ guildIds: gates().guildIds ?? [], channelIds: gates().channelIds ?? [] }}
            onChange={(p) => setGates({ guildIds: listOrUndefined(p.guildIds), channelIds: listOrUndefined(p.channelIds) })}
            guildHint="Server: all its archived channels"
          />
        </Field>
        <Show when={!timed()}>
          <Field label="Who">
            <div class={styles.inline}>
              <SegGroup role="radiogroup" ariaLabel="Whose messages" value={who()} onChange={chooseWho}>
                <SegButton value="anyone" label="Anyone" size="sm" />
                <SegButton value="only" label="Only" size="sm" />
                <SegButton value="but" label="Anyone but" size="sm" />
              </SegGroup>
              <Show when={who() !== 'anyone'}>
                <ChipRow items={gates().authorIds ?? []} label={personName} onRemove={removePerson}>
                  <AddPicker
                    label="Person"
                    search={searchPeople}
                    placeholder="Name or username"
                    empty="Nobody by that name in the archive."
                    onPick={(id) => setGates({ authorIds: [...(gates().authorIds ?? []), id] })}
                  />
                </ChipRow>
              </Show>
            </div>
          </Field>
          <Field label="Also">
            <Checks
              items={whichItems()}
              chosen={which()}
              onChange={(w) => setGates({ edits: w.includes('edited'), missed: w.includes('missed') })}
            />
          </Field>
        </Show>
        <Show when={posts() || props.input.discordSend}>
          <Field label="Post to Discord as you" for="rule-discord-send">
            <div class={styles.inline}>
              <Switch id="rule-discord-send" checked={props.input.discordSend} onChange={props.onDiscordSend} />
              <span>{props.input.discordSend ? 'Allowed' : 'Not allowed'}</span>
              <For each={actsAsYouNotes()}>{(Note) => <Note />}</For>
            </div>
            <p class={styles.warn} role="note">
              Live messages from others only. Automated posting from a user account can get it banned.
            </p>
          </Field>
        </Show>
      </div>
    </Step>
  );
}
