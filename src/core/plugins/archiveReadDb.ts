import type { Db } from '../db';
import { pluginDb } from './pluginDb';

/** Host query helpers share the served-read fence; reaching them through archive must not bypass storage.db's guard. */
export function archiveReadDb(ready: () => Db, live: () => boolean, id: string): () => Db {
  const facade = pluginDb(ready, live, id);
  const wrappers = new WeakMap<Db, Db>();
  return () => {
    const db = ready();
    let wrapper = wrappers.get(db);
    if (!wrapper) {
      wrapper = new Proxy(db, {
        get(target, key) {
          if (key === 'prepare') return facade.prepare;
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      wrappers.set(db, wrapper);
    }
    return wrapper;
  };
}
