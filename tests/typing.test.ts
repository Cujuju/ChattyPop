import { describe, expect, it } from 'vitest';
import { TypingEvents } from '../src/main/discord/typing';
import { phoneGetsAppEvent, phoneMayCallCore } from '../src/shared/phone';
import { typingParts } from '../src/shared/typing';

const text = (parts: ReturnType<typeof typingParts>): string => parts.map((p) => p.text).join('');
const names = (parts: ReturnType<typeof typingParts>): string[] => parts.filter((p) => p.kind === 'name').map((p) => p.text);

describe('typing line wording', () => {
  it('phrases one, two, three and more typists as Discord does, naming up to three', () => {
    expect(typingParts([])).toEqual([]);
    expect(text(typingParts([{ name: 'Ann' }]))).toBe('Ann is typing…');
    expect(text(typingParts([{ name: 'Ann' }, { name: 'Bo' }]))).toBe('Ann and Bo are typing…');
    expect(text(typingParts([{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cy' }]))).toBe('Ann, Bo, and Cy are typing…');
    expect(names(typingParts([{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cy' }]))).toEqual(['Ann', 'Bo', 'Cy']);
    expect(text(typingParts([{ name: 'Ann' }, { name: 'Bo' }, { name: 'Cy' }, { name: 'Di' }]))).toBe('Several people are typing…');
  });

  it('shows a custom verb only while its owner types alone', () => {
    expect(text(typingParts([{ name: 'Ann', verb: 'barking' }]))).toBe('Ann is barking…');
    expect(text(typingParts([{ name: 'Ann', verb: 'barking' }, { name: 'Bo' }]))).toBe('Ann and Bo are typing…');
  });
});

describe('typing events from the gateway', () => {
  const start = { channel_id: '1', guild_id: '2', user_id: '3', timestamp: 1 };

  it('forwards nothing until the privacy scope is known, and nothing from a hidden channel', () => {
    const events = new TypingEvents(() => undefined);
    expect(events.read('TYPING_START', start)).toBeNull();
    events.setPrivacy({ guildIds: ['2'], channelIds: ['1'] });
    expect(events.read('TYPING_START', start)).toBeNull();
    expect(events.read('TYPING_START', { ...start, channel_id: '9' })?.channelId).toBe('9');
    events.setPrivacy({ guildIds: [], channelIds: [] });
    expect(events.read('TYPING_START', start)?.channelId).toBe('1');
  });

  it("turns TYPING_START into a 'typing' event with the member's name, and nothing else into one", () => {
    const events = new TypingEvents(() => undefined);
    events.setPrivacy({ guildIds: [], channelIds: [] });
    expect(events.read('MESSAGE_CREATE', {})).toBeNull();
    expect(events.read('TYPING_START', start)).toEqual({ type: 'typing', channelId: '1', userId: '3' });
    expect(events.read('TYPING_START', { ...start, member: { nick: 'Annie', user: { id: '3', username: 'ann', global_name: 'Ann' } } })).toEqual({ type: 'typing', channelId: '1', userId: '3', name: 'Annie' });
    expect(events.read('TYPING_START', { ...start, member: { nick: null, user: { id: '3', username: 'ann', global_name: 'Ann' } } })?.name).toBe('Ann');
  });

  it('notes undocumented fields once, by name and shape only', () => {
    const notes: unknown[] = [];
    const events = new TypingEvents((event, data) => notes.push([event, data]));
    events.setPrivacy({ guildIds: [], channelIds: [] });
    const style = { typing_indicator_style: { typing_suggestion: 3, emojis: ['a'], animation: 'bounce' } };
    events.read('TYPING_START', { ...start, ...style });
    events.read('TYPING_START', { ...start, ...style });
    expect(notes).toEqual([['typing-start-extra-fields', { fields: { typing_indicator_style: 'object{typing_suggestion:number,emojis:array(1),animation:string}' }, suggestion: 3 }]]);
  });

  it('reaches the phone, which may also ask whose typing to hide', () => {
    expect(phoneGetsAppEvent({ type: 'typing', channelId: '1', userId: '3' })).toBe(true);
    expect(phoneMayCallCore('selfId')).toBe(true);
  });
});
