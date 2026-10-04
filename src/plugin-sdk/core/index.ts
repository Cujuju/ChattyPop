// Plugin core context, typed domain operations and pure mappers; SQL reads use archive views.
import type { PluginDescriptor } from '@shared/bundledTypes';
import type { CoreContext, CorePlugin } from '@core/plugins/context';

export type {
  ActionRun,
  RuleRef,
  MessageEvent,
  WindowEvent,
  MatchContext,
  FilterContext,
  FilterImpl,
  TriggerEvent,
  Settled,
  RuleEdited,
  CoverageQuery,
} from '@core/rules/kinds';
export type { Hit } from '@core/rules/hit';
export type { CoverageSpan } from '@core/textCoverage';
export type { Answers, Fresh } from '@core/jev/messageJudge';
export type { MessageFacts } from '@core/rules/compile';
export type { PluginMatchImpl, PluginRuleQuestion, PluginRules, RuleSnapshot } from '@core/plugins/rules';
export type { RuleRuns } from '@core/plugins/bundled';
export type { ManagedRule } from '@core/rules/managed';
export type { QuestionContext } from '@core/jev/messageQuestions';
export type { CoreContext, CorePlugin } from '@core/plugins/context';
export type { ActionResult, DerivedText, TextSource } from '@core/plugins/bundled';
export type { AttachmentNoteProvider, PartNoteProvider, PluginNote } from '@core/attachmentNotes';
export type { ImageAttachment, LinkImage, MessageImage, MessageImageSource } from '@core/messageImages';
export { embedText, partKey, type MediaPart, type MediaPartKind, type MessagePart, type MessagePartSource, type StoredAttachment, type TextPart } from '@core/messageParts';
export type { PartText } from '@core/derivedText';
export type { SearchRanker } from '@core/searchRankers';
export type { PluginFetch } from '@core/plugins/net';
export type { CoreFinalize, PluginCompletions } from '@core/plugins/completions';
export type { PluginDb, PluginStatement } from '@core/plugins/pluginDb';
export { PluginInactiveError } from '@shared/pluginCall';

/** A plugin's core side. `activate` runs synchronously when the plugin turns on; return a disposer only for resources it made itself. */
export const defineCorePlugin = <const D extends PluginDescriptor>(plugin: D, activate: (ctx: CoreContext<D>) => void | (() => void)): CorePlugin<D> => ({
  plugin,
  activate,
});

// Storage.
export { fromJson, parseRawJson } from '@core/db';
export type { Importer } from '@core/plugins/archiveContext';
export { storedAttachmentPath } from '@core/attachmentRetention';
// Typed domain operations.
export { embedsFrom } from '@core/queries/messageExtras';
export { privacy } from '@core/queries/privacy';
export { mutedPlaces, notificationMuted } from '@core/queries/notificationMute';
// The link index (links, message_links).
export { X_POST_URL_PREFIX, X_STATUS_PATH, normalizeUrl } from '@core/derive/links';
// Messages and AI.
export { ARRIVAL, liveAtOf, type Arrived, type TextMessage } from '@core/arrival';
export { clipMessage } from '@core/ai/clip';
export {
  HOSTED_MAX_INPUT_CHARS,
  ProviderUnavailableError,
  chosenModel,
  type CompletionImage,
  type CompletionRequest,
  type CompletionResult,
  type LlmProvider,
  type ModelOption,
  type PlanUsageWindow,
  type ProviderChoice,
  type ProviderImpl,
  type ProviderInfo,
  type ProviderReport,
} from '@core/ai/types';
export type { PriceAtApiRates, PricedUsage } from '@core/ai/apiRates';
export { sessionModels } from '@core/ai/modelCache';
export type { OpenRouterKeyReader } from '@core/ai/registry';
export { OPENROUTER_APP_HEADERS, openRouterErrorText, type OpenRouterError } from '@core/ai/openRouterKeys';
export { OPENROUTER_API, type OpenRouterKeyBalance, type OpenRouterKeyEntry } from '@shared/openrouter';
export type { PluginAi } from '@core/plugins/aiContext';
export { LocalOnlyError, boundDecider, type AiReader, type AiSources, type PluginCompletionRequest, type PluginDecider, type PluginProvider, type ReadScope } from '@core/ai/readScope';
export type { Answer, DecisionProvider, Question } from '@core/ai/decisions';
export type { PluginMessageQuestion } from '@core/plugins/jevContext';
export { MEANING_LOOKBACK_MS } from '@core/jev/messageJudge';
export { queryLabel, queryMatch, queryRequest } from '@core/jev/queries';
// Processes.
export { SerialLoop } from '@core/serialLoop';
export { deadline } from '@core/deadline';
export { IS_WINDOWS, exeName, findExecutable, resolveCli, type Launch } from '@core/ai/resolveCli';
export { signedInCli, type CliSpec } from '@core/ai/cliProvider';

export { toJson } from '@core/db';
export { sumCosts } from '@core/ai/decisions';
export { assertRange, clampCount } from '@core/queries/messageText';
export { specMatch } from '@core/jev/queries';
export { customQuestion } from '@core/jev/questions';
export type { LiveAt } from '@core/arrival';
export type { PluginLabel, MessageLabelProvider } from '@core/messageLabels';
export type { RangeJudgments } from '@core/plugins/jevContext';
export type { JudgeOptions } from '@core/jev/messageJudge';

export { isLive } from '@core/arrival';
export { snippet } from '@core/queries/snippet';
export { mentionsFrom } from '@core/queries/messageExtras';
export { questionSignature } from '@core/rules/ruleStore';
export type { RuleHistory } from '@core/rules/history';

export { USER_MENTION } from '@core/queries/messageExtras';
export { type Privacy } from '@core/queries/privacy';
export { queryFingerprint, queryStrength } from '@core/jev/queries';
export { actionRange } from '@core/rules/rangeActions';

export type { ArchivePayload, ArchivePayloadReader } from '@core/plugins/archivePayloads';
export type { ArchiveReplyReader, ArchiveReplyExists, ArchiveReplyTargets, ReplyTarget } from '@core/plugins/archiveReplies';
