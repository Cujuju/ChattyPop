import { Show } from 'solid-js';
import { postingUnlocked } from '@/state/posting';
import { ContextMenu } from '@/ui/ContextMenu';
import { QuickReactions } from '@/panels/chat/compose/QuickReactions';
import { ReactionPicker } from '@/panels/chat/compose/ReactionPicker';
import { BotModalWindow } from '@/views/botModal/BotModalWindow';
import { Lightbox } from '@/ui/Lightbox';
import { PromptDialog } from '@/ui/PromptDialog';
import { JevAsk } from '@/views/jev/JevAsk';
import { JevCheck } from '@/views/jev/JevCheck';
import { PersonView } from '@/views/person/PersonView';
import { ConversationView } from '@/views/conversation/ConversationView';
import { ForwardWindow } from '@/views/forward/ForwardWindow';
import { NewMessageWindow } from '@/views/newMessage/NewMessageWindow';
import { DmDialog } from '@/views/dmDialog/DmDialog';
import { DeleteMessageDialog } from '@/views/deleteMessage/DeleteMessageDialog';
import { DeleteAttachmentDialog, ModifyAttachmentDialog } from '@/views/attachment/AttachmentDialogs';

/** Mounts shared panel overlays: viewers, message/DM dialogs, bot forms, reaction picker, context menu and confirmations in every panel window. */
export function Overlays() {
  return (
    <>
      <Lightbox />
      <JevCheck />
      <JevAsk />
      <PersonView />
      <ConversationView />
      <ForwardWindow />
      {/* Their stores never open them while posting is locked; unmounted then as well. */}
      <Show when={postingUnlocked()}>
        <NewMessageWindow />
        <DmDialog />
        <DeleteMessageDialog />
        <ModifyAttachmentDialog />
        <DeleteAttachmentDialog />
        <BotModalWindow />
      </Show>
      <ReactionPicker />
      <ContextMenu lead={(m) => m.reactTo && <QuickReactions message={m.reactTo} x={m.x} y={m.y} />} />
      <PromptDialog />
    </>
  );
}
