// Settings and provider presentation composed from active feature wording.
import { coverageText } from '@/plugins/presentation';
import { Show } from 'solid-js';
import {
  AUTOMATIC_POST_PAUSE_MAX_S,
  AUTOMATIC_POST_PAUSE_MIN_S,
  ATTACHMENT_CAP_MAX_GB,
  ATTACHMENT_CAP_MIN_GB,
  BACKFILL_DAYS_MAX,
  BACKFILL_DAYS_MIN,
  TEXT_CAP_MAX_GB,
  TEXT_CAP_MIN_GB,
  WAIT_JITTER,
  automaticPostPauseRange,
  type SyncPace,
  type TextTier,
} from '@shared/settings';
import { settingsSections } from '@/plugins/slots';
import { coreStatus } from '@/state/core';
import { archiveSettings, patchArchiveSettings as update } from '@/state/preferences';
import { storageInfo } from '@/state/storage';
import { countText, formatBytes } from '@/ui/format';
import { Select } from '@/ui/Select';
import { Switch } from '@/ui/Switch';
import { EncryptionControl } from './EncryptionControl';
import { BotCounts } from './BotCounts';
import { ReverifyControls } from './ReverifyControls';
import { StorageLocation } from './StorageLocation';
import { Card, Note, NumberField, Row, SectionsPage, Stat, Stats, choiceOptions, settingsControl as c, type ChoiceText } from './SettingsLayout';

/** Suggested cap when turning the limit on: generous for a few busy channels. */
const DEFAULT_ATTACHMENT_CAP_GB = 10;
/** Suggested database cap: years of text for a few busy channels. */
const DEFAULT_TEXT_CAP_GB = 1;
/** Database caps are set in tenths of a GB. */
const TEXT_CAP_STEP_GB = 0.1;
/** The automatic-post pause is set in half seconds. */
const PAUSE_STEP_S = 0.5;
/** Range ends are shown to the hundredth of a second (1.95–4.05 s). */
const RANGE_DECIMALS = 2;

/** What a pause setting gives: e.g. 3 → "1.95–4.05 s". */
const pauseRangeText = (s: number): string => {
  const r = automaticPostPauseRange(s);
  const n = (x: number): number => Number(x.toFixed(RANGE_DECIMALS));
  return `${n(r.min)}–${n(r.max)} s`;
};

/** Each choice's text in its select and in the section's one-line state, in select order. */
const TIERS = (): Record<TextTier, ChoiceText> => ({
  full: { option: 'Keep as captured', meta: 'kept as captured' },
  compressed: { option: 'Compress (lossless, about half)', meta: 'compressed' },
  'summary-only': { option: coverageText().option, meta: coverageText().meta },
});
const PACES: Record<SyncPace, ChoiceText> = {
  gentle: { option: 'Gentle', meta: 'gentle pace' },
  normal: { option: 'Normal', meta: 'normal pace' },
};

/** Settings → Archive: where messages are kept, how much space they take, and what gets synced. */
export function ArchiveSection() {
  const s = archiveSettings;
  return (
    <SectionsPage
      id="archive"
      title="Archive"
      lede="Where messages are kept, how much space they take, and what gets synced."
      sections={[
        {
          id: 'storage',
          label: 'Storage',
          meta: () => `${coreStatus() ? formatBytes(coreStatus()!.totalBytes) : '…'} · ${TIERS()[s().textTier].meta}`,
          body: StorageBody,
        },
        {
          id: 'sync',
          label: 'History and sync',
          meta: () =>
            `${s().backfillDays} days · ${s().syncEnabled ? PACES[s().syncPace].meta : 'background sync off'}${s().autoArchiveSinceMs !== null ? ' · DMs archived automatically' : ''}`,
          body: SyncBody,
        },
        { id: 'posting', label: 'Automatic posts', meta: () => `pause ${pauseRangeText(s().automaticPostPauseS)}`, body: PostingBody },
        { id: 'new-counts', label: 'New-message counts', meta: () => 'Choose which bots count', body: BotCounts },
        {
          id: 'recheck',
          label: 'Re-check on startup',
          meta: () => (s().reverifyChannelIds.length ? `${countText(s().reverifyChannelIds.length, 'channel')} · ${s().reverifyDays} days` : 'Off'),
          body: ReverifyControls,
        },
        {
          id: 'location',
          label: 'Location and security',
          meta: () => `${storageInfo()?.dir ?? '…'} · ${coreStatus()?.encrypted ? 'encrypted' : 'not encrypted'}`,
          body: () => (
            <>
              <StorageLocation />
              <EncryptionControl />
            </>
          ),
        },
        ...settingsSections('archive'),
      ]}
    />
  );
}

/** A size limit: a select between no limit and a cap (oldest pruned first), then the cap in GB while on. */
function CapControl(props: {
  id: string;
  noneLabel: string;
  value: number | null;
  default: number;
  min: number;
  max: number;
  step?: number;
  ariaLabel: string;
  onChange: (gb: number | null) => void;
}) {
  return (
    <>
      <Select
        id={props.id}
        class={c.select}
        value={props.value === null ? 'all' : 'cap'}
        options={[
          { value: 'all', label: props.noneLabel },
          { value: 'cap', label: 'Limit size, oldest first' },
        ]}
        onChange={(v) => props.onChange(v === 'all' ? null : (props.value ?? props.default))}
      />
      <Show when={props.value !== null}>
        <NumberField label={props.ariaLabel} min={props.min} max={props.max} step={props.step} value={props.value ?? props.default} unit="GB" onChange={props.onChange} />
      </Show>
    </>
  );
}

function StorageBody() {
  const s = archiveSettings;
  return (
    <>
      <Show when={coreStatus()}>
        {(st) => (
          <Stats>
            <Stat label="Database" value={formatBytes(st().dbBytes)} note={s().textCapGb === null ? 'no limit' : `limit ${s().textCapGb} GB`} />
            <Stat label="Attachments" value={formatBytes(st().mediaBytes)} note={s().attachmentCapGb === null ? 'every file kept' : `limit ${s().attachmentCapGb} GB`} />
            <Stat label="Total" value={formatBytes(st().totalBytes)} note={storageInfo()?.dir} />
          </Stats>
        )}
      </Show>
      <Card>
        <Row
          label="Attachment storage"
          for="attachment-cap"
          hint="Pruned files keep their name and message; the original stays on Discord."
          control={
            <CapControl
              id="attachment-cap"
              noneLabel="Keep every attachment"
              value={s().attachmentCapGb}
              default={DEFAULT_ATTACHMENT_CAP_GB}
              min={ATTACHMENT_CAP_MIN_GB}
              max={ATTACHMENT_CAP_MAX_GB}
              ariaLabel="Attachment limit (GB)"
              onChange={(gb) => update({ attachmentCapGb: gb })}
            />
          }
        />
        <Row
          label="Older messages"
          for="text-tier"
          hint={coverageText().hint}
          control={<Select id="text-tier" class={c.select} value={s().textTier} options={choiceOptions(TIERS())} onChange={(v) => update({ textTier: v as TextTier })} />}
        >
          <Show when={s().textTier !== 'full'}>
            <Row
              label="For messages older than"
              for="text-tier-days"
              control={
                <NumberField
                  id="text-tier-days"
                  min={BACKFILL_DAYS_MIN}
                  max={BACKFILL_DAYS_MAX}
                  value={s().textTierAfterDays}
                  unit="days"
                  onChange={(n) => update({ textTierAfterDays: n })}
                />
              }
            />
          </Show>
        </Row>
        <Row
          label="Database size"
          for="text-cap"
          hint={coverageText().cap}
          control={
            <CapControl
              id="text-cap"
              noneLabel="No limit"
              value={s().textCapGb}
              default={DEFAULT_TEXT_CAP_GB}
              min={TEXT_CAP_MIN_GB}
              max={TEXT_CAP_MAX_GB}
              step={TEXT_CAP_STEP_GB}
              ariaLabel="Database limit (GB)"
              onChange={(gb) => update({ textCapGb: gb })}
            />
          }
        >
          <Show when={(coreStatus()?.textOverCapBytes ?? 0) > 0}>
            <Note>
              Still {formatBytes(coreStatus()?.textOverCapBytes ?? 0)} over the limit:{' '}
              {s().textTier === 'summary-only' ? coverageText().pending : coverageText().tier}
            </Note>
          </Show>
        </Row>
      </Card>
    </>
  );
}

function SyncBody() {
  const s = archiveSettings;
  return (
    <Card>
      <Row
        label="History when a channel is opted in"
        for="backfill-days"
        hint="Raising it extends channels on their next sync; lowering it keeps what is already stored."
        control={
          <NumberField id="backfill-days" min={BACKFILL_DAYS_MIN} max={BACKFILL_DAYS_MAX} value={s().backfillDays} unit="days" onChange={(n) => update({ backfillDays: n })} />
        }
      />
      <Row
        label="Background sync"
        for="sync-enabled"
        hint="Catch-up, backfill and attachment downloads. When off, only messages the open Discord client receives live are archived."
        control={<Switch id="sync-enabled" checked={s().syncEnabled} onChange={(on) => update({ syncEnabled: on })} />}
      />
      <Row
        label="Download pace"
        for="sync-pace"
        hint="Gentle: about one history page every 3 s and one attachment every 1.5 s; normal is about twice as fast. Gaps are randomized, and Discord's own rate limits always apply on top."
        control={<Select id="sync-pace" class={c.select} value={s().syncPace} options={choiceOptions(PACES)} onChange={(v) => update({ syncPace: v as SyncPace })} />}
      />
      <Row
        label="Archive DMs automatically when they get a message"
        for="auto-archive-dms"
        hint="From now on, a DM's next message archives it, and its history is backfilled like any channel. Message requests and DMs you stopped archiving are skipped."
        control={<Switch id="auto-archive-dms" checked={s().autoArchiveSinceMs !== null} onChange={(on) => update({ autoArchiveSinceMs: on ? Date.now() : null })} />}
      />
    </Card>
  );
}

function PostingBody() {
  const s = archiveSettings;
  return (
    <Card>
      <Row
        label="Pause before an automatic post"
        for="automatic-post-pause"
        hint={`Replies and posts plugins send for you wait this long first, so a post never lands the instant a message does. Each pause is picked at random within ±${Math.round(WAIT_JITTER * 100)}%: set to ${s().automaticPostPauseS} s, a post waits ${pauseRangeText(s().automaticPostPauseS)}. Your own messages are never held back.`}
        control={
          <NumberField
            id="automatic-post-pause"
            min={AUTOMATIC_POST_PAUSE_MIN_S}
            max={AUTOMATIC_POST_PAUSE_MAX_S}
            step={PAUSE_STEP_S}
            value={s().automaticPostPauseS}
            unit="s"
            onChange={(n) => update({ automaticPostPauseS: n })}
          />
        }
      />
    </Card>
  );
}
