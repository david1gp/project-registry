#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CONFIG_DIR="${XDG_CONFIG_HOME:-$HOME/.config}"
USER_UNIT_DIR="$CONFIG_DIR/systemd/user"
UNIT="project-registry-ui.service"

mkdir -p "$USER_UNIT_DIR"
ln -sf "$SCRIPT_DIR/$UNIT" "$USER_UNIT_DIR/$UNIT"
systemctl --user daemon-reload
systemctl --user enable --now "$UNIT"
