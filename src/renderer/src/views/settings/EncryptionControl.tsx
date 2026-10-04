// Settings and provider presentation composed from active feature wording.
import { api } from '@/api';
import { encryptionText } from '@/plugins/presentation';
import { coreStatus, refetchCoreStatus } from '@/state/core';
import { createAction } from '@/ui/action';
import { Switch } from '@/ui/Switch';
import { Card, ErrorNote, Row } from './SettingsLayout';

/** Settings → Archive: encrypt the database, with the key held by Windows for this account. */
export function EncryptionControl() {
  const action = createAction();
  const { busy, error } = action;
  const toggle = (on: boolean): void => {
    void action.run(async () => {
      await api.storage.setEncrypted(on);
      await refetchCoreStatus();
    });
  };
  return (
    <Card title="Security">
      <Row
        label="Encrypt the archive database"
        for="encrypt-archive"
        hint={encryptionText()}
        control={<Switch id="encrypt-archive" checked={coreStatus()?.encrypted ?? false} disabled={busy() || !coreStatus()} onChange={toggle} />}
      >
        <ErrorNote error={error()} />
      </Row>
    </Card>
  );
}
