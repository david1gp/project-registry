#!/usr/bin/env bash
set -euo pipefail

exec "${HOME:?}/leo/leo-server/caddy/install/install-project-registry.sh" "$@"
