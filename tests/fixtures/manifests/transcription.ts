// Transcription: voice messages and audio to text on this computer (whisper.cpp + ffmpeg). Transcripts are derived
// text: rules, Jev, summaries, search and plugin templates' {transcript} read them.
import { defineChannels, definePlugin, definePreference } from '@plugin-sdk/shared';
import { DEFAULT_TRANSCRIPTION_SETTINGS, normalizeTranscriptionSettings, type ToolBuild, type TranscriptAudioRequest, type TranscriptionStatus } from './types';

export const manifest = {
  id: 'transcription',
  name: 'Transcription',
  version: '1.0.0',
  description: 'Turns voice messages and audio into text on this computer, for rules, Jev, summaries and search.',
};

/** Settings tab id. */
export const TRANSCRIPTION_TAB = 'transcription' as const;
/** Plugin event: programs or models changed (a download started, progressed or ended); payload TranscriptionStatus. */
export const STATUS_EVENT = 'status' as const;
/** Core → main: download audio the store no longer holds (TranscriptAudioRequest); main answers with audioFetched. */
export const FETCH_AUDIO = 'fetchAudio' as const;
/** AttachmentNote.kind of a transcript. */
export const TRANSCRIPT_NOTE = 'transcript';
/**
 * Downloads main is asked for at once, and so the audioFetched report's bound; a job needing one more waits for a report.
 * Assumption: a few in parallel keep the queue moving past one slow download; more would share the link without
 * finishing sooner.
 */
export const AUDIO_FETCHES_MAX = 4;

/** Core's calls: from Settings and the message menu, and main's answer to FETCH_AUDIO. */
export interface TranscriptionCoreCalls {
  /** Programs, models and whether transcription can run. */
  status(): TranscriptionStatus;
  /**
   * Starts downloading a program or model (by InstallItem id); progress arrives as STATUS_EVENT. `build` picks a
   * program's build (null = recommended) and replaces an installed one; throws while a transcript is running.
   */
  install(id: string, build: ToolBuild | null): void;
  cancel(id: string): void;
  deleteModel(id: string): Promise<void>;
  /** Queues a transcript of an audio attachment ahead of automatic ones. Throws when transcription isn't set up. */
  request(attachmentId: string): void;
  /** Main's answer to FETCH_AUDIO `requestId`: the audio is at the requested path, or `error`. */
  audioFetched(requestId: number, error: string | null): void;
}

export interface TranscriptionEvents {
  [STATUS_EVENT]: TranscriptionStatus;
  [FETCH_AUDIO]: TranscriptAudioRequest;
}

export const plugin = definePlugin({
  manifest,
  // The phone's message menu shows whether transcription is set up, as it did before this was a plugin.
  channels: defineChannels<{ core: TranscriptionCoreCalls; events: TranscriptionEvents }>()({
    core: {
      status: { audiences: ['renderer', 'phone'], writes: false },
      install: ['renderer'],
      cancel: ['renderer'],
      deleteModel: ['renderer'],
      request: ['renderer'],
      audioFetched: { audiences: ['main'], completion: { max: AUDIO_FETCHES_MAX } },
    },
    events: { [STATUS_EVENT]: ['renderer', 'phone'], [FETCH_AUDIO]: ['main'] },
  }),
  settings: [
    // A microphone: its capsule (a rounded 6 × 11 rect at 9, 3), its stand's arc and foot.
    { id: TRANSCRIPTION_TAB, label: 'Transcription', tab: { after: 'archive', iconPath: 'M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM5 11a7 7 0 0 0 14 0M12 18v3' } },
  ],
  // Pinned programs and models (core/catalog.ts): Hugging Face and GitHub releases, and the CDNs they redirect to.
  network: { hosts: ['huggingface.co', 'hf.co', 'github.com', 'githubusercontent.com'] },
  /** Settings → Transcription. */
  preferences: { settings: definePreference({ default: DEFAULT_TRANSCRIPTION_SETTINGS, normalize: normalizeTranscriptionSettings }) },
  slots: { messageMenu: [{ id: 'transcribe', after: 'copy' }] },
  // Its queue's table, settings and downloads' folder from when it was built in.
  adopts: { tables: { transcripts: 'jobs' }, settings: { transcription: 'settings' }, dataDir: 'transcription' },
});
export default plugin;
