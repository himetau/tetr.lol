#!/usr/bin/env bash
# Install a .desktop launcher for lst.trainer (uses system electron).
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$DESKTOP_DIR"

if [ ! -d "$APP_DIR/dist" ]; then
  echo "dist/ missing — run 'npm run build' first" >&2
  exit 1
fi

cat > "$DESKTOP_DIR/lst-trainer.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=lst.trainer
Comment=LST stacking practice client with live placement feedback
Exec=/usr/bin/electron $APP_DIR
Icon=$APP_DIR/electron/icon.png
Categories=Game;
StartupWMClass=lst-trainer
Terminal=false
EOF

update-desktop-database "$DESKTOP_DIR" 2>/dev/null || true
echo "installed $DESKTOP_DIR/lst-trainer.desktop"
