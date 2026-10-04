// Notification settings: the desktop switch composed from active notice kinds, and muted servers and channels.
import { andList } from '@shared/lists';
import { notificationKinds } from '@/plugins/slots';
import { notificationSettings, patchNotificationSettings } from '@/state/preferences';
import { Switch } from '@/ui/Switch';
import { PlacePicker } from './PlacePicker';
import { Card, Page, Row } from './SettingsLayout';

/** What the switch covers besides the active notice kinds' subjects. */
const HOST_SUBJECT = 'plugins';

/** Settings → Notifications: Windows notifications on or off (active notice kinds say what it covers), and muted places. */
export function NotificationsSection() {
  const desktop = () => notificationKinds().flatMap((kind) => kind.desktop ?? []);
  return (
    <Page id="notifications" title="Notifications" lede={['What reaches you outside the app.', ...desktop().flatMap((d) => d.note ?? [])].join(' ')}>
      <Card>
        <Row
          label={`Windows notifications for ${andList([...desktop().map((d) => d.subject), HOST_SUBJECT])}`}
          for="desktop-notifications"
          hint={desktop().flatMap((d) => d.hint ?? []).join(' ') || undefined}
          control={
            <Switch
              id="desktop-notifications"
              checked={notificationSettings().desktop}
              onChange={(on) => patchNotificationSettings({ desktop: on })}
            />
          }
        />
        <Row
          label="Muted servers and channels"
          hint="No notifications about them on this PC or your phones; alerts still land in the inbox. A channel covers its threads."
        >
          <PlacePicker
            places={notificationSettings().muted}
            onChange={(muted) => patchNotificationSettings({ muted })}
            guildHint="Server: all its channels"
          />
        </Row>
      </Card>
    </Page>
  );
}
