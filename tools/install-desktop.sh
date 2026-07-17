#!/usr/bin/env bash
# Install a .desktop launcher for tetr.lol (uses system electron).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"

if [ ! -d "$APP_DIR/dist" ]; then
  echo "dist/ missing — run 'npm run build' first" >&2
  exit 1
fi

# drop launchers from before the tetr.lol rename
rm -f "$DESKTOP_DIR/lst-trainer.desktop" "$DESKTOP_DIR/tetr-ai.desktop"

cat > "$DESKTOP_DIR/tetr-lol.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=tetr.lol
Comment=LST stacking practice client with live placement feedback
Exec=/usr/bin/electron $APP_DIR
Icon=$APP_DIR/electron/icon.png
Categories=Game;
StartupWMClass=tetr-lol
Terminal=false
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
echo "installed $DESKTOP_DIR/tetr-lol.desktop"
