export type WindowChrome = 'controls' | 'traffic-lights';
export interface WindowFrameState { maximized: boolean; fullScreen: boolean; }
export interface WindowControls {
  readonly chrome: WindowChrome;
  minimize(): void;
  toggleMaximize(): void;
  close(): void;
  state(): Promise<WindowFrameState>;
  onStateChanged(listener: (s: WindowFrameState) => void): () => void;
}
export const WINDOW_CHROME_ARG = '--cp-window-chrome=';
export const WINDOW_CONTROL_CHANNELS = {
  minimize: 'window:minimize', toggleMaximize: 'window:toggle-maximize',
  close: 'window:close', state: 'window:state', changed: 'window:state-changed',
} as const;
/** Matches --cp-topbar-h; native lights are approximately 12 logical pixels tall. */
const TOP_BAR_HEIGHT = 48;
const TRAFFIC_LIGHT_HEIGHT = 12;
/** One light diameter of space precedes the native controls. */
const TRAFFIC_LIGHT_LEFT_INSET = TRAFFIC_LIGHT_HEIGHT;
export const MAC_TRAFFIC_LIGHTS_POSITION = { x: TRAFFIC_LIGHT_LEFT_INSET, y: (TOP_BAR_HEIGHT - TRAFFIC_LIGHT_HEIGHT) / 2 };
