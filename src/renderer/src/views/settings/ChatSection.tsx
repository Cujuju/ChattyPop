// Settings → Chat: Discord's Chat settings (synced with the account while Sync across clients is on) and this PC's own.
import { Show, createSignal } from 'solid-js';
import {
  SPOILER_MODES,
  SPOILER_MODE_LABELS,
  SWIPE_ACTIONS,
  SWIPE_ACTION_LABELS,
  VIDEO_QUALITIES,
  VIDEO_QUALITY_LABELS,
  type DeviceChatSettings,
  type SpoilerMode,
  type SwipeAction,
  type SyncedChatSettings,
  type VideoQuality,
} from '@shared/chatSettings';
import { changeDeviceChatSettings, changeDiscordChatSettings, deviceChatSettings, discordChatSettings, setSyncAcrossClients } from '@/state/chatSettings';
import { createAction } from '@/ui/action';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { ChatEmoji, DoubleTapEmojiPicker } from './DoubleTapEmoji';
import { Card, ErrorNote, Page, Row, SettingsButton, settingsControl as c } from './SettingsLayout';

type DiscordSwitchKey = { [K in keyof SyncedChatSettings]: SyncedChatSettings[K] extends boolean ? K : never }[keyof SyncedChatSettings];
type DeviceSwitchKey = { [K in keyof DeviceChatSettings]: DeviceChatSettings[K] extends boolean ? K : never }[keyof DeviceChatSettings];

const options = <T extends string>(all: readonly T[], labels: Readonly<Record<T, string>>) => all.map((value) => ({ value, label: labels[value] }));

/** Settings → Chat, laid out as Discord's mobile Chat settings. */
export function ChatSection() {
  const write = createAction();
  const discord = (change: Partial<SyncedChatSettings>): void => void write.run(() => changeDiscordChatSettings(change));
  const [picking, setPicking] = createSignal(false);

  const DiscordSwitch = (props: { id: string; setting: DiscordSwitchKey; label: string; hint?: string }) => (
    <Row
      label={props.label}
      for={props.id}
      hint={props.hint}
      control={<Switch id={props.id} checked={discordChatSettings()[props.setting]} onChange={(on) => discord({ [props.setting]: on })} />}
    />
  );
  const DeviceSwitch = (props: { id: string; setting: DeviceSwitchKey; label: string; hint?: string }) => (
    <Row
      label={props.label}
      for={props.id}
      hint={props.hint}
      control={<Switch id={props.id} checked={deviceChatSettings()[props.setting]} onChange={(on) => void changeDeviceChatSettings({ [props.setting]: on })} />}
    />
  );

  return (
    <Page id="chat" title="Chat" lede="How messages show and what the composer does. Discord’s own settings follow your account; the rest are this PC’s.">
      <ErrorNote error={write.error()} />
      <Card title="Show images and videos">
        <DiscordSwitch id="chat-link-media" setting="inlineLinkMedia" label="When posted as links to chat" />
        <DiscordSwitch id="chat-attachment-media" setting="inlineAttachmentMedia" label="When uploaded directly to Discord" hint="Off: uploads show as files." />
        <DiscordSwitch id="chat-image-descriptions" setting="imageDescriptions" label="With image descriptions" />
      </Card>
      <Card title="Video uploads">
        <Row
          label="Quality"
          for="chat-video-quality"
          control={
            <Select
              id="chat-video-quality"
              class={c.select}
              value={deviceChatSettings().videoQuality}
              options={options(VIDEO_QUALITIES, VIDEO_QUALITY_LABELS)}
              onChange={(v) => void changeDeviceChatSettings({ videoQuality: v as VideoQuality })}
            />
          }
        />
        <DeviceSwitch id="chat-data-saving" setting="dataSaving" label="Data saving mode" hint="Uploads at Data Saver quality on a cellular network." />
      </Card>
      <Card title="Embeds and link previews">
        <DiscordSwitch id="chat-embeds" setting="renderEmbeds" label="Show embeds and preview website links pasted into chat" />
      </Card>
      <Card title="Emoji">
        <DiscordSwitch id="chat-reactions" setting="renderReactions" label="Show emoji reactions on messages" />
        <DiscordSwitch id="chat-emoticons" setting="convertEmoticons" label="Automatically convert emoticons in your messages to emoji" hint="For example, :) becomes 🙂." />
      </Card>
      <Card title="Spoilers">
        <Row
          label="Show spoiler content"
          for="chat-spoilers"
          control={
            <Select
              id="chat-spoilers"
              class={c.select}
              value={discordChatSettings().spoilers}
              options={options(SPOILER_MODES, SPOILER_MODE_LABELS)}
              onChange={(v) => discord({ spoilers: v as SpoilerMode })}
            />
          }
        />
      </Card>
      <Card title="Stickers">
        <DiscordSwitch id="chat-stickers" setting="stickersInAutocomplete" label="Show stickers in autocomplete results" />
      </Card>
      <Card title="Gestures">
        <Row
          label="Swipe right to left"
          for="chat-swipe"
          control={
            <Select
              id="chat-swipe"
              class={c.select}
              value={deviceChatSettings().swipeAction}
              options={options(SWIPE_ACTIONS, SWIPE_ACTION_LABELS)}
              onChange={(v) => void changeDeviceChatSettings({ swipeAction: v as SwipeAction })}
            />
          }
        />
        <DeviceSwitch id="chat-double-tap" setting="doubleTapReact" label="Double tap to react" />
        <Row
          label="Double tap emoji"
          control={
            <>
              <ChatEmoji emoji={deviceChatSettings().doubleTapEmoji} />
              <SettingsButton aria-expanded={picking()} onClick={() => setPicking(!picking())}>
                {picking() ? 'Close' : 'Change'}
              </SettingsButton>
            </>
          }
        >
          <Show when={picking()}>
            <DoubleTapEmojiPicker onPicked={() => setPicking(false)} />
          </Show>
        </Row>
      </Card>
      <Card title="Sync">
        <Row
          label="Sync across clients"
          for="chat-sync"
          hint="On: Discord’s settings above are your account’s, and changes here reach Discord’s other apps. Off: this PC keeps its own."
          control={<Switch id="chat-sync" checked={discordChatSettings().syncAcrossClients} onChange={(on) => void setSyncAcrossClients(on)} />}
        />
      </Card>
    </Page>
  );
}
