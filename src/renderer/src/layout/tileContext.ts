// The workspace tile a panel renders in, so its header can be the tile's grip, tab strip and tab target.
import { createContext, useContext } from 'solid-js';
import type { TileContext } from '@cujuju/solidjs-tiling-window-manager';

/** Null outside the main window's layout: panel windows, in-app windows, the phone. */
export const TileScope = createContext<TileContext | null>(null);

export const useTile = (): TileContext | null => useContext(TileScope);
