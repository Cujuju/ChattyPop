// Archive storage operations: moving, channel suggestion samples.

export type StorageMovePhase = 'stopping' | 'copying' | 'verifying' | 'restarting' | 'error';

/** Recent messages of a channel that isn't archived, fetched for a suggestion and never stored. */
export interface ChannelSample {
  channelId: string;
  channelName: string;
  messages: { author: string; content: string }[];
}

/** A channel Jev thinks matches the owner's rules; score = its best rule probability. */
export interface ChannelSuggestion {
  channelId: string;
  score: number;
  rules: string[];
}

/** What main tells the owner after a restart it caused (a failed archive move or check), until dismissed. */
export interface StorageNotice {
  title: string;
  message: string;
}

export interface StorageInfo {
  /** Folder holding the archive database and media. */
  dir: string;
  /** The folder the archive was moved from, while its copy is still on disk; null once deleted. */
  previousDir: string | null;
  /** The size of that copy's database and media; null with no copy. */
  previousBytes: number | null;
  notice: StorageNotice | null;
}

/** Sent once by main right after forking core. */
/** The archive folder holds this database file (plus its -wal/-shm) and this media folder. */
export const ARCHIVE_DB_FILE = 'archive.db';
export const ARCHIVE_MEDIA_DIR = 'media';
/** Folder under the media folder holding archived attachments (core prunes it, main downloads into it). */
export const ARCHIVE_ATTACHMENTS_DIR = 'attachments';
