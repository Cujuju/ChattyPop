import type { OwnerMessage, PostedOwnerMessage } from '@shared/compose';

export const ACCEPTED_AT = Date.UTC(2026, 9, 7);
export const ACCEPTED_ID = '1420000000000000000';
export const ACCEPTED_AUTHOR = '100000000000000002';

export const acceptedMessage = (m: OwnerMessage): PostedOwnerMessage => ({
  nonce: m.nonce,
  message: {
    id: ACCEPTED_ID, channel_id: m.channelId, author: { id: ACCEPTED_AUTHOR, username: 'owner' },
    content: m.text, timestamp: new Date(ACCEPTED_AT).toISOString(), edited_timestamp: null,
    nonce: m.nonce,
  },
});
