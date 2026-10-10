#!/bin/sh
# Installs "ChattyPop Dev.app" on macOS: a clickable app with ChattyPop's icon that runs this checkout's dev build
# (`pnpm dev`), so the dev build starts from the Dock, Launchpad or Spotlight like an installed one.
#
#   scripts/installMacDevApp.sh [pluginDirs]
#
# pluginDirs is CHATTYPOP_PLUGIN_DIRS' value (docs/plugins.md). Default: that variable, else the plugin repo clones
# beside this checkout. Run it again after moving the checkout or to change the plugin folders.
set -eu

NAME='ChattyPop Dev'
CHECKOUT=$(cd "$(dirname "$0")/.." && pwd -P)
SIBLINGS=$(dirname "$CHECKOUT")

# The plugin repos cloned beside this checkout, as CHATTYPOP_PLUGIN_DIRS joins them.
sibling_plugins() {
  found=''
  for repo in ChattyPop-Plugins-Public ChattyPop-Plugins-Private; do
    [ -d "$SIBLINGS/$repo/plugins" ] && found="${found:+$found:}$SIBLINGS/$repo/plugins"
  done
  printf '%s' "$found"
}
PLUGIN_DIRS=${1:-${CHATTYPOP_PLUGIN_DIRS:-$(sibling_plugins)}}

# /Applications when this account may write there, else the account's own Applications folder.
if [ -w /Applications ]; then DEST=/Applications; else DEST="$HOME/Applications"; fi
APP="$DEST/$NAME.app"
rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

# The icon, at each size macOS asks for, from the app's own.
ICONSET=$(mktemp -d)/icon.iconset
mkdir "$ICONSET"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" "$CHECKOUT/build/icon.png" --out "$ICONSET/icon_${size}x${size}.png" >/dev/null
  sips -z $((size * 2)) $((size * 2)) "$CHECKOUT/build/icon.png" --out "$ICONSET/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$APP/Contents/Resources/icon.icns"
rm -rf "$(dirname "$ICONSET")"

# LSUIElement: the launcher itself shows no Dock icon and exits at once; the dev build's Electron shows ChattyPop's.
# LSArchitecturePriority: a bundle whose program is a script would otherwise start under Rosetta on Apple silicon.
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>com.cujuju.chattypop.dev</string>
  <key>CFBundleExecutable</key><string>launch</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>dev</string>
  <key>LSUIElement</key><true/>
  <key>LSArchitecturePriority</key><array><string>arm64</string><string>x86_64</string></array>
</dict>
</plist>
EOF

# The quoted heredoc keeps the launcher's own variables; the two paths are filled in below.
cat >"$APP/Contents/MacOS/launch" <<'EOF'
#!/bin/sh
# Starts the dev build of the ChattyPop checkout below, or brings it forward when it is already running.
# Written by scripts/installMacDevApp.sh; run that again rather than editing this.
CHECKOUT='__CHECKOUT__'
PLUGIN_DIRS='__PLUGIN_DIRS__'
ELECTRON="$CHECKOUT/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
LOG="$HOME/Library/Logs/ChattyPop-dev.log"
PIDFILE="$HOME/Library/Caches/ChattyPop-dev.pid"
# Set in shells hosted by Electron apps; it would make the binary run as plain Node.
unset ELECTRON_RUN_AS_NODE
cd "$CHECKOUT" || exit 1

# Running, even hidden in the menu bar: a second start finds the first, which raises its window, and quits.
if pgrep -f "$ELECTRON \\." >/dev/null; then exec "$ELECTRON" .; fi
# Still building from an earlier click: nothing to do but wait for it.
if [ -f "$PIDFILE" ] && kill -0 "$(cat "$PIDFILE")" 2>/dev/null; then exit 0; fi

# A login shell, as a terminal would start: an app opened from the Finder has only the system's bare PATH, without
# node and pnpm. Detached, so the dev build outlives this launcher; its output goes to the log.
CHATTYPOP_PLUGIN_DIRS="$PLUGIN_DIRS" nohup "${SHELL:-/bin/zsh}" -ilc 'exec pnpm dev' >"$LOG" 2>&1 &
echo $! >"$PIDFILE"
EOF
# Paths can't hold a single quote here (the launcher quotes them with one); refuse rather than write a broken script.
case "$CHECKOUT$PLUGIN_DIRS" in *\'*) echo "A path with a single quote can't be used: $CHECKOUT $PLUGIN_DIRS" >&2; exit 1 ;; esac
ESCAPED_CHECKOUT=$(printf '%s' "$CHECKOUT" | sed 's/[&|\\]/\\&/g')
ESCAPED_PLUGINS=$(printf '%s' "$PLUGIN_DIRS" | sed 's/[&|\\]/\\&/g')
sed -i '' "s|__CHECKOUT__|$ESCAPED_CHECKOUT|; s|__PLUGIN_DIRS__|$ESCAPED_PLUGINS|" "$APP/Contents/MacOS/launch"
chmod +x "$APP/Contents/MacOS/launch"

echo "Installed $APP"
echo "  checkout: $CHECKOUT"
echo "  plugins:  ${PLUGIN_DIRS:-none}"
echo "  log:      ~/Library/Logs/ChattyPop-dev.log"
case "$CHECKOUT" in "$HOME"/Documents/* | "$HOME"/Desktop/* | "$HOME"/Downloads/*)
  echo "The checkout is in a folder macOS protects: the first start asks to let \"$NAME\" access it. Allow it once." ;;
esac
