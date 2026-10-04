import { expect, it, vi } from 'vitest';
import { requireSecretStorage } from '@main/secretFile';

// A plugin folder has no electron: the host's copy resolves for both, so this mock is what the host module imports.
vi.mock('electron', () => ({ safeStorage: { isEncryptionAvailable: () => false } }));

it('mocks the electron the host imports', () => expect(requireSecretStorage).toThrow('OS encryption is unavailable'));
