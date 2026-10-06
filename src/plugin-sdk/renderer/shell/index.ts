// First-party phone/page SDK exposes transport plumbing, root and host shell slots. Only declared phone transport plugins may import it.
export { createPhoneRendererApi, type PhoneRendererApi, type PhoneTransport } from './phoneApi';
export { installRendererApi, pageEvents, pageFetch, reloadPage } from './transport';
export { showPhoneTextSize, startPage } from './page';
export type { AppEvent } from '@shared/contract';
export { DESKTOP_CONNECTED_EVENT, DesktopUnreachableError } from '@shared/phone';

// The phone's host slots and shell parts.
export { phoneDrawerPanes, phoneNoticeKinds, phoneOverviewText, phoneSectionFor, phoneTabs } from '@/phone/slots';
export { Overlays } from '@/frame/Overlays';
export { Search } from '@/frame/Search';
// Whether Search is in use: a shell that keeps its field put away shows it while this is true.
export { searchOpen } from '@/state/search';
export { panelImportance, type SectionId } from '@/panels/titles';
export { archiveChannelId, archiveLoads, focusMessageId } from '@/state/archive';
export { longPressOpensMenus, swipeOutcome, type TouchPoint } from '@/ui/touch';
// A section's pane marks its panel seen while on screen, as a desktop layout slot does.
export { markSeenWhileShown } from '@/ui/seen';
