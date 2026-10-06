// A feature's own provider and model (Image text, Translation): a provider, then its models as Settings → AI lists them.
import { Show, type JSX } from 'solid-js';
import type { ModelOption } from '@shared/contract';
import type { HostSettingsTabId } from '@shared/anchors';
import { Select } from '@/ui/Select';
import { openSettingsAt } from '@/state/ui';
import { LinkButton } from './rules/PatternBuilder';
import { ModelList } from './ModelList';
import { Note, Row, settingsControl as c } from './SettingsLayout';

/** Settings → AI: where a provider is turned on and installs models (Ollama's "Install a model"). */
const AI_SETTINGS: HostSettingsTabId = 'ai';
/** The provider select's choice while none is saved. */
const NONE = '';

/** A provider as the feature's core side lists it: its models of the kind the feature uses. */
export interface ProviderModels {
  id: string;
  label: string;
  /** Runs on this PC. */
  local: boolean;
  /** Why it can't be used now (its plugin is off, it isn't reachable); null while it can. */
  unavailable: string | null;
  models: ModelOption[];
}

export interface ModelRowsProps {
  /** Element ids' prefix: one set per picker on the page. */
  id: string;
  providers: readonly ProviderModels[];
  providerId: string | null;
  modelId: string | null;
  /** A new provider starts with no model picked: models belong to a provider. */
  onChange(providerId: string | null, modelId: string | null): void;
  /** Shown when no provider offers this kind of model. */
  none: string;
  /** Which of its models count, when not all ("that reads images"). */
  kind?: string;
  modelHint?: JSX.Element;
  /** Reasons a provider can't be used that this page fixes itself (a switch on it): no link to Settings → AI. */
  fixedHere?: (why: string) => boolean;
}

/** ModelRows selects feature provider/model; ProviderSelect uses the provider’s AI-settings model. No model defaults before selection. */
export function ModelRows(props: ModelRowsProps) {
  const provider = (): ProviderModels | undefined => props.providers.find((p) => p.id === props.providerId);
  const providerOptions = () => [
    ...(provider() ? [] : [{ value: NONE, label: 'Pick a provider…' }]),
    ...props.providers.map((p) => ({ value: p.id, label: p.unavailable ? `${p.label} (can’t be used)` : p.label })),
  ];
  const settingsAi = () => <LinkButton onClick={() => openSettingsAt(AI_SETTINGS)}>Open Settings → AI</LinkButton>;
  return (
    <>
      <Show when={props.providers.length} fallback={<Note>{props.none}</Note>}>
        <Row
          label="Provider"
          for={`${props.id}-provider`}
          control={<Select id={`${props.id}-provider`} class={c.select} value={provider()?.id ?? NONE} options={providerOptions()} onChange={(v) => props.onChange(v || null, null)} />}
        />
      </Show>
      <Show when={provider()}>
        {(p) => (
          <>
            <Show when={p().unavailable}>
              {(why) => (
                <Note>
                  {p().label} can’t be used: {why()} {props.fixedHere?.(why()) ? null : settingsAi()}
                </Note>
              )}
            </Show>
            <Show
              when={p().models.length}
              fallback={
                <Show when={!p().unavailable}>
                  <Note>
                    No model on {p().label}
                    {props.kind ? ` ${props.kind}` : ''} is installed. <LinkButton onClick={() => openSettingsAt(AI_SETTINGS)}>Install one in Settings → AI</LinkButton>
                  </Note>
                </Show>
              }
            >
              <ModelList name={`${props.id}-model`} models={p().models} value={props.modelId} unset="none" onChange={(model) => props.onChange(p().id, model)} />
              <Show when={props.modelHint}>
                <Note>{props.modelHint}</Note>
              </Show>
            </Show>
          </>
        )}
      </Show>
    </>
  );
}
