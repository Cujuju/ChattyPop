import { For, Show, createResource, createSignal } from 'solid-js';
import type { ChannelBackfillHistory } from '@shared/archiveSettings';
import { archivedChannels, channelLabel } from '@/state/directory';
import { archiveSettings, patchArchiveSettings } from '@/state/preferences';
import { ageLabel } from '@/state/statusBar';
import { backfillCost, type BackfillCost } from '@/state/syncDetails';
import { countText, errorText, toLocalInput, yearDate } from '@/ui/format';
import { BackfillControl } from './BackfillControl';
import { PlacePicker, type Places } from './PlacePicker';
import { Card, Note, Row, SettingsButton } from './SettingsLayout';
import settings from './Settings.module.css';

export function channelHistoryMeta(): string {
  const overrides = archiveSettings().channelBackfillHistory;
  const count = archivedChannels().filter((ch) => Object.hasOwn(overrides, ch.id)).length;
  return count ? `${count} ${count === 1 ? 'differs' : 'differ'} from the default` : 'all use the default';
}

const NO_PLACES: Places = { guildIds: [], channelIds: [] };

/** What a depth costs, in words: requests and time, and what the estimate leaves out. */
function costText(cost: BackfillCost): string {
  const unknown = cost.unknown ? ` Not known for ${countText(cost.unknown, 'channel')} with too little stored.` : '';
  if (!cost.pages) return cost.unknown ? `No estimate yet.${unknown}` : 'Nothing more to fetch: what is stored reaches that far.';
  return `About ${countText(cost.pages, 'request')}, roughly ${ageLabel(cost.durationMs)} at the ${archiveSettings().syncPace} pace.${unknown} Threads add their own.`;
}

/** One depth for several archived channels and DMs at once, with what fetching it costs before it is applied. */
function SeveralAtOnce() {
  const [places, setPlaces] = createSignal(NO_PLACES);
  const [depth, setDepth] = createSignal<ChannelBackfillHistory | undefined>('complete');
  const chosen = (): string[] => {
    const servers = new Set(places().guildIds);
    const channels = new Set(places().channelIds);
    return archivedChannels().filter((ch) => servers.has(ch.guildId) || channels.has(ch.id)).map((ch) => ch.id);
  };
  const since = (): number | undefined => {
    const d = depth();
    return d && d !== 'complete' && 'sinceMs' in d ? d.sinceMs : undefined;
  };
  const [cost] = createResource(() => (chosen().length ? { ids: chosen(), depth: depth() } : null), (q) => backfillCost(q.ids, q.depth));
  const estimate = (): string => {
    if (!chosen().length) return 'Pick the channels, DMs or whole servers to change.';
    if (cost.error) return errorText(cost.error);
    const known = cost.loading ? undefined : cost();
    return known ? costText(known) : 'Estimating…';
  };
  const setSince = (value: string): void => {
    const sinceMs = Date.parse(value);
    if (Number.isFinite(sinceMs)) setDepth({ sinceMs });
  };
  const apply = (): void => {
    const overrides = { ...archiveSettings().channelBackfillHistory };
    const d = depth();
    for (const id of chosen()) {
      if (d === undefined) delete overrides[id];
      else overrides[id] = d;
    }
    void patchArchiveSettings({ channelBackfillHistory: overrides });
    setPlaces(NO_PLACES);
  };
  return (
    <Card title="Set several at once">
      <Row label="Channels and DMs" hint={estimate()}>
        <PlacePicker places={places()} onChange={setPlaces} guildHint="Server: all its archived channels" />
      </Row>
      <Row
        label="History"
        for="history-several-unit"
        control={<BackfillControl id="history-several" value={depth()} defaultHistory={archiveSettings().backfillHistory} onChange={setDepth} />}
      />
      <Show when={since()}>
        {(ms) => (
          <Row
            label="Nothing before"
            for="history-several-since"
            control={
              <input
                id="history-several-since"
                class={settings.input}
                type="datetime-local"
                value={toLocalInput(ms())}
                onChange={(e) => setSince(e.currentTarget.value)}
              />
            }
          />
        )}
      </Show>
      <Row
        label={chosen().length ? `Applies to ${countText(chosen().length, 'channel')}` : 'Nothing chosen'}
        control={<SettingsButton disabled={!chosen().length} onClick={apply}>Apply</SettingsButton>}
      />
    </Card>
  );
}

/** Settings → Archive: each archived channel or DM can override the default history depth. */
export function ChannelHistoryControls() {
  const choice = (id: string): ChannelBackfillHistory | undefined => archiveSettings().channelBackfillHistory[id];
  const hint = (id: string, guildName: string): string => {
    const history = choice(id);
    return history && history !== 'complete' && 'sinceMs' in history ? `${guildName} · Since ${yearDate(history.sinceMs)}` : guildName;
  };
  const change = (id: string, history: ChannelBackfillHistory | undefined): void => {
    const overrides = { ...archiveSettings().channelBackfillHistory };
    if (history === undefined) delete overrides[id];
    else overrides[id] = history;
    void patchArchiveSettings({ channelBackfillHistory: overrides });
  };
  return (
    <>
      <Note>Each archived channel and DM can keep its own depth. Threads follow their channel. A deeper choice is fetched right away.</Note>
      <SeveralAtOnce />
      <Card title="Channels and DMs">
        <For each={archivedChannels()} fallback={<Row label="No archived channels or DMs yet" />}>
          {(ch) => (
            <Row
              label={channelLabel(ch)}
              for={`history-${ch.id}-unit`}
              hint={hint(ch.id, ch.guildName)}
              control={
                <BackfillControl
                  id={`history-${ch.id}`}
                  value={choice(ch.id)}
                  defaultHistory={archiveSettings().backfillHistory}
                  onChange={(history: ChannelBackfillHistory | undefined) => change(ch.id, history)}
                />
              }
            />
          )}
        </For>
      </Card>
    </>
  );
}
