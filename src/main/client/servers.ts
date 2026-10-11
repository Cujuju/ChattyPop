// The servers a client knows, most recently used first: an origin each, kept in the client's profile.
import { readFileSync, writeFileSync } from 'node:fs';
import type { SavedServer } from '@shared/desktopShell';
import { serverOrigin } from '../launchMode';

/** What a server list reads and writes: a file in the client's profile; tests pass a stand-in. */
export interface ServerStore {
  read(): string | null;
  write(text: string): void;
}

/** The file at `path` as a ServerStore; a missing or unreadable file reads as none. */
export const fileStore = (path: string): ServerStore => ({
  read: () => {
    try {
      return readFileSync(path, 'utf8');
    } catch {
      return null;
    }
  },
  write: (text) => writeFileSync(path, text),
});

const isSaved = (v: unknown): v is SavedServer =>
  typeof v === 'object' && v !== null && typeof (v as SavedServer).origin === 'string' && serverOrigin((v as SavedServer).origin) === (v as SavedServer).origin && Number.isFinite((v as SavedServer).lastUsedAt);

export class ServerList {
  private servers: SavedServer[];

  constructor(private readonly store: ServerStore) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(store.read() ?? '[]');
    } catch {
      // Unreadable: no saved servers; the owner adds theirs again.
    }
    this.servers = Array.isArray(parsed) ? parsed.filter(isSaved) : [];
  }

  /** Most recently used first. */
  list(): SavedServer[] {
    return [...this.servers].sort((a, b) => b.lastUsedAt - a.lastUsedAt);
  }

  /** The server used last; null when none is saved. */
  last(): string | null {
    return this.list()[0]?.origin ?? null;
  }

  /** Saves the server `input` names (an address or a URL; https only) as used now; returns its origin. */
  add(input: string, now = Date.now()): string {
    const origin = serverOrigin(input);
    if (!origin) throw new Error('Enter the server’s https address, like pc.example.ts.net:8443.');
    this.servers = [...this.servers.filter((s) => s.origin !== origin), { origin, lastUsedAt: now }];
    this.save();
    return origin;
  }

  remove(origin: string): void {
    this.servers = this.servers.filter((s) => s.origin !== origin);
    this.save();
  }

  private save(): void {
    this.store.write(JSON.stringify(this.servers));
  }
}
