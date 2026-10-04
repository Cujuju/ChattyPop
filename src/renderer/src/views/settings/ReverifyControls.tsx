import { For, Show } from 'solid-js';
import { REVERIFY_DAYS_MAX, REVERIFY_DAYS_MIN } from '@shared/settings';
import { archivedChannels, channelLabel } from '@/state/directory';
import { archiveSettings, patchArchiveSettings } from '@/state/preferences';
import { Switch } from '@/ui/Switch';
import { Card, Note, NumberField, Row } from './SettingsLayout';

/** Settings → Archive: channels re-fetched at startup to catch edits and deletes made while the app was closed. */
export function ReverifyControls() {
  const chosen = (id: string): boolean => archiveSettings().reverifyChannelIds.includes(id);
  const toggle = (id: string, on: boolean): void => {
    const rest = archiveSettings().reverifyChannelIds.filter((x) => x !== id);
    patchArchiveSettings({ reverifyChannelIds: on ? [...rest, id] : rest });
  };
  return (
    <>
      <Note>Fetches recent history again each time the app starts, so edits and deletes made while it was closed are caught. Costs a few requests per channel.</Note>
      <Card title="Channels">
        <For each={archivedChannels()} fallback={<Row label="No archived channels yet" />}>
          {(ch) => (
            <Row
              label={channelLabel(ch)}
              for={`reverify-${ch.id}`}
              hint={ch.guildName}
              control={<Switch id={`reverify-${ch.id}`} checked={chosen(ch.id)} onChange={(on) => toggle(ch.id, on)} />}
            />
          )}
        </For>
      </Card>
      <Show when={archiveSettings().reverifyChannelIds.length}>
        <Card>
          <Row
            label="How far back"
            for="reverify-days"
            control={
              <NumberField
                id="reverify-days"
                min={REVERIFY_DAYS_MIN}
                max={REVERIFY_DAYS_MAX}
                value={archiveSettings().reverifyDays}
                unit="days"
                onChange={(n) => patchArchiveSettings({ reverifyDays: n })}
              />
            }
          />
        </Card>
      </Show>
    </>
  );
}
