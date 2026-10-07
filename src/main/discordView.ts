import { readFileSync, writeFileSync } from 'node:fs';
import { WebContentsView, type BrowserWindow } from 'electron';
import type { DiscordSlot, PrivacyScope } from '@shared/contract';
import { DM_GUILD_ID, SNOWFLAKE_DIGITS } from '@shared/discord';
import { errorMessage } from '@shared/errors';
import { DEFAULT_DISCORD_SIDEBAR, type DiscordSidebar } from '@shared/settings';
import { GatewayTap } from './discord/gatewayTap';
import { watchModals } from './discord/modalWatch';
import { PageWorld } from './discord/pageWorld';
import { privacyCss } from './discord/privacyCss';
import { sidebarCss } from './discord/sidebarCss';
import { diag } from './diagnostics';
import { guardNavigation } from './externalLinks';
import { profilePath } from './storageLocation';

/** Session partition holding the user's Discord login; persists across restarts. */
export const DISCORD_PARTITION = 'persist:discord';
const DISCORD_ORIGIN = 'https://discord.com';
const DISCORD_APP_URL = `${DISCORD_ORIGIN}/app`;
/** The last channel the live client showed, so the next start reopens it (the client's own /app lands on Friends). */
const LAST_ROUTE_FILE = 'discord-route.json';
const DISCORD_HOSTS = new Set(['discord.com', 'www.discord.com', 'canary.discord.com', 'ptb.discord.com']);

const isDiscordUrl = (url: string): boolean => {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && DISCORD_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
};

/** Where the client goes when privacy mode hides the channel it shows: the DM home. */
const PRIVACY_FALLBACK_PATH = `/channels/${DM_GUILD_ID}`;

/** Discord client routes: /channels/<guild or @me>/<channel>[/<message>]. */
const CHANNEL_PATH = new RegExp(`^/channels/(${DM_GUILD_ID}|${SNOWFLAKE_DIGITS})/(${SNOWFLAKE_DIGITS})`);

const lastRoutePath = (): string => profilePath(LAST_ROUTE_FILE);

/** Startup route uses the last channel or client default. */
function startUrl(): string {
  try {
    const { route } = JSON.parse(readFileSync(lastRoutePath(), 'utf8')) as { route?: unknown };
    if (typeof route === 'string' && CHANNEL_PATH.test(route)) return DISCORD_ORIGIN + route;
  } catch {
    // No saved route yet (first start) or an unreadable file: open the default.
  }
  return DISCORD_APP_URL;
}

function saveRoute(route: string): void {
  try {
    writeFileSync(lastRoutePath(), JSON.stringify({ route }));
  } catch (err) {
    diag('discord-route-save-failed', { message: errorMessage(err) });
  }
}

/** Hosts the real Discord web client as a native view positioned over the renderer's chat slot. */
export class DiscordView {
  private readonly view: WebContentsView;
  readonly tap: GatewayTap;
  /** Where ChattyPop's scripts run in the page: its DOM, not its globals. */
  readonly world: PageWorld;
  /** Called when the live client shows a channel (guild id, or "@me" for DMs). */
  onChannel: ((guildId: string, channelId: string) => void) | undefined;
  /** Called for each new document (load or reload): page injections are per document. */
  onDomReady: (() => void) | undefined;
  private savedRoute: string | undefined;
  private sidebar: DiscordSidebar = DEFAULT_DISCORD_SIDEBAR;
  private privacy: PrivacyScope = { guildIds: [], channelIds: [] };
  /** The server and channel the client shows. */
  private shown: { guildId: string; channelId: string } | undefined;
  /** Key of the injected stylesheet (sidebar and privacy) in the current document; insertCSS is per document, so a reload drops it. */
  private pageCssKey: string | undefined;
  /** Serializes re-injection so rapid toggles can't leave two stylesheets in the page. */
  private pageCssApply: Promise<void> = Promise.resolve();
  /** Where the renderer's chat slot is, and whether it shows. */
  private slot: DiscordSlot = { visible: false, x: 0, y: 0, width: 0, height: 0 };
  /** Open Discord modals expand the native view to the full window. */
  private modalOpen = false;

  /** The server and channel the client shows now; undefined before it shows one. */
  get shownChannel(): { guildId: string; channelId: string } | undefined {
    return this.shown;
  }

  constructor(private readonly win: BrowserWindow) {
    this.view = new WebContentsView({
      webPreferences: { partition: DISCORD_PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false },
    });
    this.view.setVisible(false);
    win.contentView.addChildView(this.view);

    const wc = this.view.webContents;
    this.tap = new GatewayTap(wc);
    this.world = new PageWorld(wc);
    watchModals(wc, this.world, (open) => {
      this.modalOpen = open;
      this.applyBounds();
    });
    guardNavigation(wc, isDiscordUrl);
    const notePath = (url: string): void => {
      const path = new URL(url).pathname;
      if (path.startsWith('/login')) diag('discord-login-page', { path });
      const channel = CHANNEL_PATH.exec(path);
      this.shown = channel ? { guildId: channel[1]!, channelId: channel[2]! } : undefined;
      if (!channel || this.leaveIfHidden()) return;
      this.onChannel?.(channel[1]!, channel[2]!);
      // Restore channel routes without old message targets.
      if (channel[0] !== this.savedRoute) saveRoute((this.savedRoute = channel[0]));
    };
    wc.on('did-navigate', (_e, url) => notePath(url));
    wc.on('did-navigate-in-page', (_e, url) => notePath(url));
    wc.on('dom-ready', () => {
      this.pageCssKey = undefined;
      this.applyPageCss();
      this.onDomReady?.();
    });
    // Load now, hidden, after the tap is attached: header and gateway capture run even when the panel isn't shown.
    void wc.loadURL(startUrl());
  }

  get webContents(): Electron.WebContents {
    return this.view.webContents;
  }

  setSlot(slot: DiscordSlot): void {
    this.slot = slot;
    this.applyBounds();
  }

  /** Over the slot; over the whole window while a modal is open. Hidden whenever the slot is. */
  private applyBounds(): void {
    const { slot } = this;
    const visible = slot.visible && slot.width > 0 && slot.height > 0;
    if (visible) {
      const [width, height] = this.win.getContentSize() as [number, number];
      this.view.setBounds(
        this.modalOpen
          ? { x: 0, y: 0, width, height }
          : { x: Math.round(slot.x), y: Math.round(slot.y), width: Math.round(slot.width), height: Math.round(slot.height) },
      );
    }
    this.view.setVisible(visible);
  }

  /** Navigates Discord in-page with pushState/popstate; falls back to direct route loading if script execution fails. */
  openChannel(guildId: string, channelId: string): void {
    const path = `/channels/${guildId}/${channelId}`;
    if (CHANNEL_PATH.exec(path)?.[0] !== path) return; // only well-formed channel routes reach the page
    this.showPath(path);
  }

  private showPath(path: string): void {
    const script = `history.pushState(null, '', ${JSON.stringify(path)}); dispatchEvent(new PopStateEvent('popstate', { state: null }));`;
    this.world.evaluate(script).catch((err: unknown) => {
      diag('discord-open-channel-fallback', { message: errorMessage(err) });
      void this.view.webContents.loadURL(DISCORD_ORIGIN + path);
    });
  }

  setSidebar(sidebar: DiscordSidebar): void {
    this.sidebar = sidebar;
    this.applyPageCss();
  }

  /** Hides privacy mode's servers and channels, and leaves the one shown if it is now hidden. */
  setPrivacy(scope: PrivacyScope): void {
    this.privacy = scope;
    this.applyPageCss();
    this.leaveIfHidden();
  }

  /** Goes to the DM home when privacy mode hides the shown server or channel; true when it did. */
  private leaveIfHidden(): boolean {
    const s = this.shown;
    if (!s || !(this.privacy.guildIds.includes(s.guildId) || this.privacy.channelIds.includes(s.channelId))) return false;
    this.showPath(PRIVACY_FALLBACK_PATH);
    return true;
  }

  private applyPageCss(): void {
    const wc = this.view.webContents;
    this.pageCssApply = this.pageCssApply
      .then(async () => {
        if (wc.isDestroyed()) return;
        const previous = this.pageCssKey;
        this.pageCssKey = undefined;
        // A key from a document since replaced by a reload no longer exists; nothing to remove then.
        if (previous) await wc.removeInsertedCSS(previous).catch(() => undefined);
        const css = [sidebarCss(this.sidebar), privacyCss(this.privacy)].filter(Boolean).join('\n');
        if (css) this.pageCssKey = await wc.insertCSS(css);
      })
      .catch((err: unknown) => diag('discord-page-css-failed', { message: errorMessage(err) }));
  }

  /** Closes the Discord page the way a browser tab closes (unload handlers run), so its storage is consistent at quit. */
  async closeGracefully(): Promise<void> {
    const wc = this.view.webContents;
    if (wc.isDestroyed()) return;
    diag('quit-unload-start');
    const destroyed = new Promise<'unloaded'>((resolve) => wc.once('destroyed', () => resolve('unloaded')));
    wc.close({ waitForBeforeUnload: true });
    const how = await Promise.race([destroyed, new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), PAGE_UNLOAD_TIMEOUT_MS))]);
    diag('quit-unload-end', { how });
  }
}

/** Upper bound for the Discord page's unload handlers at quit. */
const PAGE_UNLOAD_TIMEOUT_MS = 3000;
