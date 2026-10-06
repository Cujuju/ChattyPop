// Tags: the owner's manual and Jev labels, rules, range runs and archive views.
import { defineChannels, definePlugin } from '@plugin-sdk/shared';
import type { MessageTagChip, Tag, TagInput, TaggedMessage, TagRangeRequest, TagRangeResult, PersonTags } from './types';
import { applied, anyTag, applyTag } from './rules';

/** Calls served by the Tags core side. */
export interface TagsCoreCalls {
  /** The owner's tags, by name. */
  tags(): Tag[];
  /** Throws with a message for the editor. Returns the new tag's id. */
  createTag(input: TagInput): number;
  updateTag(id: number, input: TagInput): void;
  deleteTag(id: number): void;
  /** The owner adds (on) or takes off (off) a tag on one message; Jev no longer decides it there. */
  setMessageTag(messageId: string, tagId: number, on: boolean): void;
  /** Tags shown on one message. */
  messageTags(messageId: string): MessageTagChip[];
  /** Messages carrying a tag, newest first. */
  taggedMessages(tagId: number, limit: number): TaggedMessage[];
  /** Counts messages in a range for cost estimation. */
  tagRangeCount(req: TagRangeRequest): number;
  /** Asks the chosen tags' Jev questions about every message in a range and applies the tags they meet. */
  tagRange(req: TagRangeRequest): Promise<TagRangeResult>;
  /** Tags on one channel's newest tagged messages, by message id, for the live client's chips. */
  liveTagChips(channelId: string): Record<string, MessageTagChip[]>;
  personTags(userId: string): PersonTags | null;
}
/** Tags changed on these messages; null means the tag definitions changed. */
export interface TagsEvents {
  changed: { messageIds: string[] | null };
}
/** Descriptor preserves the legacy panel, rule names and stored ids. */
export const plugin = definePlugin({
  manifest: {
    id: 'tags',
    name: 'Tags',
    version: '1.0.0',
    description: 'Your own message tags, applied by hand, Jev or rules.',
  },
  channels: defineChannels<{
    core: TagsCoreCalls;
    events: TagsEvents;
  }>()({
    core: {
      tags: { audiences: ['renderer', 'phone'], writes: false },
      createTag: ['renderer'],
      updateTag: ['renderer'],
      deleteTag: ['renderer'],
      setMessageTag: ['renderer'],
      messageTags: { audiences: ['renderer', 'phone'], writes: false },
      taggedMessages: { audiences: ['renderer', 'phone'], writes: false },
      tagRangeCount: ['renderer'],
      tagRange: ['renderer'],
      liveTagChips: { audiences: ['renderer', 'phone', 'main'], writes: false },
      personTags: { audiences: ['renderer', 'phone'], writes: false },
    },
    events: { changed: ['renderer', 'phone', 'main'] },
  }),
  panels: [{
    id: 'tags',
    title: 'Tags',
    importance: 'reference',
    dialog: false,
    after: 'chat',
    iconPath: 'M3.5 12.5V4.5a1 1 0 0 1 1-1h8l8.5 8.5-9 9zM9.5 8a1.5 1.5 0 1 0-3 0a1.5 1.5 0 1 0 3 0',
  }],
  rules: {
    triggers: [applied],
    filters: [anyTag],
    actions: [applyTag],
  },
  search: {
    tokens: [{
      key: 'tag',
      description: 'Carries one of your tags',
      value: 'tag name',
    }],
  },
  jev: { features: [{ key: 'customTags', label: 'Your own tags', default: false, after: 'messageClasses' }] },
  slots: {
    messageMenu: [{ id: 'tags', before: 'jev' }],
    personSections: [{ id: 'tags' }],
    ruleTemplates: [{ id: 'tags', after: 'links' }],
  },
  adopts: {
    // Its switch kept its key from before Tags was a plugin.
    jevFeatures: { customTags: 'customTags' },
    tables: {
      tags: 'tags',
      message_tags: 'message_tags',
    },
  },
});
export default plugin;
