import { For } from 'solid-js';
import type { ChannelBackfillHistory } from '@shared/archiveSettings';
import { archivedChannels, channelLabel } from '@/state/directory';
import { archiveSettings, patchArchiveSettings } from '@/state/preferences';
import { yearDate } from '@/ui/format';
import { BackfillControl } from './BackfillControl';
import { Card, Note, Row } from './SettingsLayout';

export function channelHistoryMeta(): string {
  const overrides = archiveSettings().channelBackfillHistory;
  const count = archivedChannels().filter((ch) => Object.hasOwn(overrides, ch.id)).length;
  return count ? `${count} ${count === 1 ? 'differs' : 'differ'} from the default` : 'all use the default';
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
      <Note>Each archived channel and DM can keep its own depth. Threads follow their channel.</Note>
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
