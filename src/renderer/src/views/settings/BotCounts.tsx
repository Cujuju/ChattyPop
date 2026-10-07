import { For, Show, createSignal } from 'solid-js';
import { countedBots, countedBotsLoaded, createArchivedBots, setBotCounted } from '@/state/countedBots';
import { failure, settled } from '@plugin-sdk/renderer/settled';
import { errorMessage } from '@shared/errors';
import { Switch } from '@/ui/Switch';
import { Card, Note, Row } from './SettingsLayout';

/** Settings → Archive: which bots count toward new-message and notable badges and the opening banner. */
export function BotCounts() {
  const bots = createArchivedBots();
  const [ready, setReady] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  void countedBotsLoaded.then(() => setReady(true), (err) => setError(errorMessage(err)));
  const toggle = (id: string, on: boolean): void => {
    setError(null);
    void setBotCounted(id, on).catch((err) => setError(errorMessage(err)));
  };
  return (
    <>
      <Note>Choose which bots count as new messages, including notable counts and the “new since” banner. Bots are excluded until you turn them on.</Note>
      <Show when={failure(bots)}><Note>Could not load archived bots. Close and reopen this section to try again.</Note></Show>
      <Show when={error()}>{(message) => <Note>{message()}</Note>}</Show>
      <Card title="Bots in archived channels">
        <For each={settled(bots)} fallback={<Row label={bots.loading ? 'Loading bots…' : failure(bots) ? 'Bots unavailable' : 'No bots in archived channels yet'} />}>
          {(bot) => <Row
            label={bot.name}
            for={`count-bot-${bot.id}`}
            hint={`@${bot.username} · ${bot.id}`}
            control={<Switch id={`count-bot-${bot.id}`} checked={countedBots().includes(bot.id)} disabled={!ready()} onChange={(on) => toggle(bot.id, on)} />}
          />}
        </For>
      </Card>
    </>
  );
}
