import { ipcRenderer, type IpcRendererEvent } from 'electron';
import { WINDOW_CHROME_ARG, WINDOW_CONTROL_CHANNELS as channels, type WindowControls, type WindowFrameState } from '@shared/windowControls';

/** A system-framed window has no controls bridge. */
export function windowControls(): WindowControls | undefined {
  const chrome = process.argv.find((a) => a.startsWith(WINDOW_CHROME_ARG))?.slice(WINDOW_CHROME_ARG.length);
  if (chrome !== 'controls' && chrome !== 'traffic-lights') return undefined;
  return {
    chrome,
    minimize: () => ipcRenderer.send(channels.minimize),
    toggleMaximize: () => ipcRenderer.send(channels.toggleMaximize),
    close: () => ipcRenderer.send(channels.close),
    state: () => ipcRenderer.invoke(channels.state),
    onStateChanged: (listener) => {
      const handler = (_e: IpcRendererEvent, state: WindowFrameState): void => listener(state);
      ipcRenderer.on(channels.changed, handler);
      return () => { ipcRenderer.off(channels.changed, handler); };
    },
  };
}
