// Core methods for AI providers and Jev's on-demand checks.
import type { AppEvent, CoreMethods } from '@shared/contract';
import { errorMessage } from '@shared/errors';
import type { AiSettings } from '@shared/settings';
import type { DecisionProvider } from './ai/decisions';
import type { ProviderRegistry } from './ai/registry';
import { usageSince } from './ai/usage';
import type { Db } from './db';
import { askRange } from './jev/askRange';
import { checkMessage } from './jev/messageCheck';
import { MessageJudge } from './jev/messageJudge';
import type { JevSpendLedger } from './jevSpend';

type Handlers = Pick<
  CoreMethods,
  | 'aiStatus'
  | 'aiPlanUsage'
  | 'jevSpend'
  | 'aiUsageSince'
  | 'setOpenRouterKeys'
  | 'setTypeSafeKey'
  | 'openRouterKeys'
  | 'openRouterBalances'
  | 'jevStatus'
  | 'jevCheckMessage'
  | 'jevAskRange'
>;

const MESSAGE_CHECK_HINT = 'Turn on Settings → Jev → Right-click Jev check, with a Jev connection set up (OpenRouter or TypeSafe).';

export function aiHandlers(o: {
  db: () => Db;
  providers: ProviderRegistry;
  jevLedger: JevSpendLedger;
  aiSettings: () => AiSettings;
  /** A Jev decider for a per-feature switch, or throws `hint`. */
  requireDecider: (feature: 'messageCheck', hint: string) => DecisionProvider;
  emit: (e: AppEvent) => void;
}): Handlers {
  const { providers } = o;
  return {
    aiStatus: (refresh) => providers.status(o.aiSettings(), refresh),
    aiPlanUsage: (id) => providers.planUsage(id, o.aiSettings()),
    jevSpend: () => o.jevLedger.spend(o.db()),
    aiUsageSince: (id, sinceTs) => usageSince(id, sinceTs),
    setOpenRouterKeys: (keys) => providers.setOpenRouterKeys(keys),
    openRouterKeys: () => providers.keyInfos(),
    openRouterBalances: () => providers.keyBalances(),
    setTypeSafeKey: (key) => providers.setTypeSafeKey(key),
    jevStatus: () => providers.jevStatus(o.aiSettings()),
    jevCheckMessage: (messageId, ask) => {
      const jev = o.requireDecider('messageCheck', MESSAGE_CHECK_HINT);
      const db = o.db();
      return checkMessage(db, new MessageJudge(db), jev, messageId, ask);
    },
    jevAskRange: (ask) => {
      const jev = o.requireDecider('messageCheck', MESSAGE_CHECK_HINT);
      const db = o.db();
      return askRange(db, new MessageJudge(db), jev, ask);
    },
  };
}
