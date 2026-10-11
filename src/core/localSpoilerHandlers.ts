// Personal spoiler marks live in the archive; every device changes one part without replacing another device's marks.
import type { AppEvent, CoreMethods } from '@shared/contract';
import { normalizeLocalSpoilers } from '@shared/localSpoilers';
import { SETTINGS_KEYS } from '@shared/settings';
import { getSetting, setSetting, type Db } from './db';

export function localSpoilerHandlers(db: () => Db, emit: (event: AppEvent) => void): Pick<CoreMethods, 'setLocalSpoiler'> {
  return {
    setLocalSpoiler: (key, marked) => {
      if (typeof key !== 'string' || !key || typeof marked !== 'boolean') throw new Error('Invalid local spoiler change.');
      // No async work between reading and saving: core serializes desktop and phone changes against current storage.
      const archive = db();
      const marks = new Set(normalizeLocalSpoilers(getSetting(archive, SETTINGS_KEYS.localSpoilers)));
      if (marked) marks.add(key);
      else marks.delete(key);
      const value = [...marks];
      setSetting(archive, SETTINGS_KEYS.localSpoilers, value);
      emit({ type: 'setting-changed', key: SETTINGS_KEYS.localSpoilers, value });
      return value;
    },
  };
}
