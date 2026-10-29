// A plugin as the host holds it, and its disposal.
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { PluginManifest, PluginOrigin, PluginStatus } from '@shared/plugins';
import { unregisterMessageQuestion } from '../jev/messageQuestions';
import { emptyRegistrations, type Registrations } from './api';
import type { CorePlugin } from './context';

export interface Loaded {
  manifest: PluginManifest;
  /** The plugin folder; '' for a bundled plugin. */
  dir: string;
  origin: PluginOrigin;
  /** Set for a descriptor plugin (bundled or installed) that loaded; null for a folder plugin or a refused installed one. */
  entry: BundledEntry | null;
  status: PluginStatus;
  error: string | null;
  reg: Registrations;
  deactivate?: () => void;
  /** Set once unloaded: an activation still running then disposes what it returns instead of committing it. */
  retired?: true;
}

/** Bundled descriptor and optional core side. */
export interface BundledEntry {
  plugin: PluginDescriptor;
  core: CorePlugin | null;
}

/** Drops everything the activation registered; each cleanup runs on its own, so one that throws is logged and the rest still run. */
export function unload(p: Loaded): void {
  p.retired = true;
  p.reg.unloaded = true;
  p.reg.timers.forEach(clearInterval);
  for (const dispose of p.reg.disposers) cleanup(p, 'cleanup', dispose);
  p.reg.jevQuestions.forEach(unregisterMessageQuestion);
  if (p.deactivate) cleanup(p, 'deactivate', p.deactivate);
  p.reg = emptyRegistrations();
  p.deactivate = undefined;
}

/** Runs one of a plugin's cleanups; a throw is logged, never passed on. */
export function cleanup(p: Loaded, what: string, fn: () => void): void {
  try {
    fn();
  } catch (err) {
    console.error(`[plugin ${p.manifest.id}] ${what} failed`, err);
  }
}
