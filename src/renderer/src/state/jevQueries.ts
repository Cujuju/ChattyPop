import { api } from '@/api';
import { createResource } from 'solid-js';
import type { JevQueryOverrides, JevRerunRequest, JevRerunResult } from '@shared/jevQueries';
import { SETTINGS_KEYS } from '@shared/settings';
import type { CustomJevQuestion } from '@shared/jevQuestion';
import { onAppEvent } from './events';

const core = api.core;

/** The owner's edits to built-in Jev queries (Settings → Jev → Queries), by query id. */
export const [jevQueryOverrides, { refetch: refetchJevQueryOverrides }] = createResource((): Promise<JevQueryOverrides> => core.jevQueryOverrides(), { initialValue: {} });

onAppEvent('setting-changed', (e) => {
  if (e.key === SETTINGS_KEYS.jevQueries) void refetchJevQueryOverrides();
});

/** Saves an edit (null = back to the default); throws with the reason when the app can't use it. */
export async function saveJevQuery(id: string, q: CustomJevQuestion | null): Promise<void> {
  await core.setJevQuery(id, q);
  await refetchJevQueryOverrides();
}

export const jevRerunCount = (req: JevRerunRequest): Promise<number> => core.jevRerunCount(req);
export const jevRerun = (req: JevRerunRequest): Promise<JevRerunResult> => core.jevRerun(req);
