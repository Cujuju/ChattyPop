// Core methods that each forward to one service, looked up at call time (services exist once the archive opens).
import { pluginCallResult } from '@shared/pluginCall';
import { normalizeSearchSort } from '@shared/searchQuery';
import type { CoreMethods } from '@shared/contract';
import type { Db } from './db';
import type { PluginHost } from './plugins/host';
import { conversation } from './queries/conversation';
import { ownCommands } from './queries/ownCommands';
import { ownEmoji, ownReactions } from './queries/ownEmoji';
import { mentionCandidates } from './queries/mentions';
import { findPeople, peopleByIds } from './queries/people';
import { personNames } from './queries/personNames';
import { personProfile } from './queries/person';
import { cachedMutualFriends, cachedProfile, cachedReactors, storeMutualFriends, storeProfile, storeReactors } from './discordProfiles';
import { parseSearch, searchMessages } from './queries/search';
import type { RuleService } from './rules/ruleService';
import { rankSearch } from './searchRankers';
import { previewPattern } from './patternPreview';

export const ruleHandlers = (
  rules: () => RuleService,
  db: () => Db,
): Pick<CoreMethods, 'rules' | 'createRule' | 'updateRule' | 'deleteRule' | 'ruleRuns' | 'patternPreview'> => ({
  rules: () => rules().list(),
  createRule: (input) => rules().create(input),
  updateRule: (id, input) => rules().update(id, input),
  deleteRule: (id) => rules().remove(id),
  ruleRuns: (ruleId, limit) => rules().runs(ruleId, limit),
  patternPreview: (pattern, channelIds, contains) => previewPattern(db(), pattern, channelIds, contains),
});

/** Search (reordered by plugins' search rankers), people (with Discord's cached profiles) and conversations, and the owner's emoji and commands. */
export const queryHandlers = (
  db: () => Db,
  selfId: () => string | null,
): Pick<CoreMethods, 'searchMessages' | 'personProfile' | 'discordProfile' | 'storeDiscordProfile' | 'mutualFriends' | 'storeMutualFriends' | 'reactors' | 'storeReactors' | 'findPeople' | 'peopleByIds' | 'personNames' | 'mentionCandidates' | 'conversation' | 'ownEmoji' | 'ownReactions' | 'ownCommands' | 'rankSearch'> => ({
  searchMessages: (text, limit, sort) => searchMessages(db(), text, limit, normalizeSearchSort(sort)),
  personProfile: (userId) => personProfile(db(), userId),
  discordProfile: (userId, guildId) => cachedProfile(db(), userId, guildId),
  storeDiscordProfile: (f) => storeProfile(db(), f),
  mutualFriends: (userId) => cachedMutualFriends(db(), userId),
  storeMutualFriends: (userId, friends, at) => storeMutualFriends(db(), userId, friends, at),
  reactors: (messageId, emojiKey) => cachedReactors(db(), messageId, emojiKey),
  storeReactors: (messageId, emojiKey, users, count, at) => storeReactors(db(), messageId, emojiKey, users, count, at),
  findPeople: (query, limit) => findPeople(db(), query, limit),
  peopleByIds: (ids) => peopleByIds(db(), ids),
  personNames: (ids, channelId) => personNames(db(), ids, channelId),
  mentionCandidates: (channelId, query, limit) => mentionCandidates(db(), selfId(), channelId, query, limit),
  conversation: (messageId) => conversation(db(), messageId),
  ownEmoji: (limit) => {
    const id = selfId();
    return id ? ownEmoji(db(), id, limit) : [];
  },
  ownReactions: (limit) => ownReactions(db(), limit),
  ownCommands: (limit) => {
    const id = selfId();
    return id ? ownCommands(db(), id, limit) : [];
  },
  rankSearch: (text, hits) => rankSearch(parseSearch(text).words, hits),
});

export const pluginHandlers = (host: () => PluginHost): Pick<CoreMethods, 'plugins' | 'setPluginEnabled' | 'reloadPlugins' | 'runPluginCommand' | 'pluginCall'> => ({
  plugins: () => host().list(),
  setPluginEnabled: (id, on) => host().setEnabled(id, on),
  reloadPlugins: () => host().reload(),
  runPluginCommand: (pluginId, commandId, range) => host().runCommand(pluginId, commandId, range),
  pluginCall: (origin, pluginId, name, args) => pluginCallResult(() => host().call(origin, pluginId, name, args)),
});
