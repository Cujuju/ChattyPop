// The notification-area icon and taskbar badge: the tray opens the main window, restarts (installing a downloaded update) and quits;
// both show which kinds are unread (badgeImage.ts draws their dots).
import { Menu, Tray, nativeImage, type BrowserWindow, type NativeImage } from 'electron';
import { NO_UNREAD, UNREAD_KINDS, unreadSummary, type UnreadKind, type UnreadTotals } from '@shared/unread';
import { dotsBitmap, withDots, type Bitmap } from './badgeImage';

const APP_NAME = 'ChattyPop';
/** Small-icon size in DIPs (Windows' SM_CXSMICON at 100%): the tray icon and the taskbar overlay. */
const SMALL_ICON_DIP = 16;
/** Display scales drawn ahead, so Windows picks a sharp copy instead of stretching one (100–200%). */
const DRAWN_SCALES = [1, 1.25, 1.5, 2] as const;

/** An image with one copy per drawn scale, each `draw(pixels)` at that scale's small-icon size. */
function smallIcon(draw: (px: number) => Bitmap): NativeImage {
  const image = nativeImage.createEmpty();
  for (const scaleFactor of DRAWN_SCALES) {
    const { width, height, data } = draw(Math.round(SMALL_ICON_DIP * scaleFactor));
    image.addRepresentation({ scaleFactor, width, height, buffer: data });
  }
  return image;
}

/** `icon` scaled to `px` square, as a bitmap. */
function scaled(icon: NativeImage, px: number): Bitmap {
  return { width: px, height: px, data: icon.resize({ width: px, height: px, quality: 'best' }).toBitmap() };
}

export interface TrayActions {
  open(): void;
  restart(): void;
  quit(): void;
}

export class AppTray {
  private readonly tray: Tray;
  private readonly icon: NativeImage;
  private readonly plain: NativeImage;
  /** The tray icon and taskbar overlay for each set of unread kinds, drawn on first use. */
  private readonly drawn = new Map<string, { tray: NativeImage; overlay: NativeImage }>();
  private unread: UnreadTotals = NO_UNREAD;
  /** The downloaded update's version, while one waits to be installed. */
  private update: string | null = null;

  constructor(
    private readonly win: BrowserWindow,
    iconPath: string,
    private readonly actions: TrayActions,
  ) {
    this.icon = nativeImage.createFromPath(iconPath);
    this.plain = smallIcon((px) => scaled(this.icon, px));
    this.tray = new Tray(this.plain);
    this.tray.on('click', () => actions.open());
    this.render();
  }

  /** Unread counts to show, per kind (zero for a kind turned off); a rise while the window is in the background flashes
      its taskbar button. */
  setUnread(unread: UnreadTotals): void {
    if (UNREAD_KINDS.every((k) => unread[k] === this.unread[k])) return;
    const rose = UNREAD_KINDS.some((k) => unread[k] > this.unread[k]);
    if (rose && !this.win.isDestroyed() && !this.win.isFocused()) this.win.flashFrame(true);
    this.unread = unread;
    this.render();
  }

  setUpdate(version: string | null): void {
    if (version === this.update) return;
    this.update = version;
    this.render();
  }

  private images(kinds: readonly UnreadKind[]): { tray: NativeImage; overlay: NativeImage } {
    const key = kinds.join('+');
    const cached = this.drawn.get(key);
    if (cached) return cached;
    const images = { tray: smallIcon((px) => withDots(scaled(this.icon, px), kinds)), overlay: smallIcon((px) => dotsBitmap(px, kinds)) };
    this.drawn.set(key, images);
    return images;
  }

  private render(): void {
    const kinds = UNREAD_KINDS.filter((k) => this.unread[k] > 0);
    const text = unreadSummary(this.unread);
    const images = kinds.length > 0 ? this.images(kinds) : null;
    this.tray.setImage(images?.tray ?? this.plain);
    this.tray.setToolTip(text ? `${APP_NAME}: ${text}` : APP_NAME);
    if (!this.win.isDestroyed()) this.win.setOverlayIcon(images?.overlay ?? null, text ?? '');
    this.tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: `Open ${APP_NAME}`, click: () => this.actions.open() },
        { type: 'separator' },
        { label: this.update ? `Restart to update to ${this.update}` : `Restart ${APP_NAME}`, click: () => this.actions.restart() },
        { label: `Quit ${APP_NAME}`, click: () => this.actions.quit() },
      ]),
    );
  }
}
