// Settings → Desktop: starting at sign-in, the tray, the show/hide shortcut, the leader key and updates.
import { Show } from 'solid-js';
import { api } from '@/api';
import type { DesktopSettings, UpdateStatus } from '@shared/desktop';
import { desktopState, patchDesktopSettings } from '@/state/desktop';
import { createAction } from '@/ui/action';
import { Switch } from '@/ui/Switch';
import { Card, ErrorNote, Page, Row, SettingsButton } from './SettingsLayout';
import { HotkeyRow, LeaderKeyRow, ShortcutKeyList } from './ShortcutKeys';

/** What the Updates row says for each phase. */
function updateText(u: UpdateStatus): string | null {
  switch (u.phase) {
    case 'unsupported':
      return 'Installed builds only.';
    case 'idle':
      return null;
    case 'checking':
      return 'Checking…';
    case 'current':
      return 'Up to date.';
    case 'downloading':
      return `Downloading ${u.version}: ${u.percent}%`;
    case 'ready':
      return `${u.version} is ready. Restarting keeps your Discord sign-in.`;
    case 'failed':
      return `Couldn’t update: ${u.message}`;
  }
}

/** A switch row for one desktop setting. */
function SettingSwitch(props: { id: string; setting: keyof Omit<DesktopSettings, 'hotkey'>; label: string; hint?: string }) {
  return (
    <Row
      label={props.label}
      for={props.id}
      hint={props.hint}
      control={
        <Switch
          id={props.id}
          checked={desktopState()?.settings[props.setting] ?? false}
          disabled={!desktopState()}
          onChange={(on) => void patchDesktopSettings({ [props.setting]: on })}
        />
      }
    />
  );
}

export function DesktopSection() {
  const login = createAction();
  const update = createAction();
  const status = (): UpdateStatus => desktopState()?.update ?? { phase: 'unsupported' };
  const openAtLogin = (): boolean | null | undefined => desktopState()?.openAtLogin;
  return (
    <Page id="desktop" title="Desktop" lede="Startup, tray, shortcuts and updates.">
      <Card title="Start">
        <Row
          label="Start at Windows sign-in"
          for="desktop-open-at-login"
          hint={openAtLogin() === null ? 'Installed builds only.' : undefined}
          control={
            <Switch
              id="desktop-open-at-login"
              checked={openAtLogin() ?? false}
              disabled={openAtLogin() == null || login.busy()}
              onChange={(on) => void login.run(() => api.desktop.setOpenAtLogin(on))}
            />
          }
        >
          <ErrorNote error={login.error()} />
        </Row>
        <SettingSwitch
          id="desktop-start-hidden"
          setting="startHidden"
          label="Start in the tray"
          hint="When started at sign-in."
        />
      </Card>
      <Card title="Tray">
        <SettingSwitch id="desktop-minimize-to-tray" setting="minimizeToTray" label="Minimize to the tray" />
        <SettingSwitch
          id="desktop-close-to-tray"
          setting="closeToTray"
          label="Close to the tray"
          hint="Quit from the tray icon’s menu."
        />
        <SettingSwitch
          id="desktop-indicate-chat"
          setting="indicateChat"
          label="Dot for unread messages"
          hint="Blue, on the tray and taskbar icons."
        />
        <SettingSwitch
          id="desktop-indicate-alerts"
          setting="indicateAlerts"
          label="Dot for new alerts"
          hint="Red. The bell shows alerts either way."
        />
      </Card>
      <Card title="Shortcuts">
        <HotkeyRow />
        <LeaderKeyRow />
        <ShortcutKeyList />
      </Card>
      <Card title="Updates">
        <Row
          label={`Version ${desktopState()?.version ?? ''}`}
          hint={updateText(status()) ?? undefined}
          control={
            <Show
              when={status().phase === 'ready'}
              fallback={
                <SettingsButton
                  disabled={['unsupported', 'checking', 'downloading'].includes(status().phase) || update.busy()}
                  onClick={() => void update.run(() => api.desktop.checkForUpdate())}
                >
                  Check for updates
                </SettingsButton>
              }
            >
              <SettingsButton onClick={() => void update.run(() => api.desktop.installUpdate())}>Restart to update</SettingsButton>
            </Show>
          }
        >
          <ErrorNote error={update.error()} />
        </Row>
      </Card>
    </Page>
  );
}
