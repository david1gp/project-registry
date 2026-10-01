#!/usr/bin/env bash
set -euo pipefail

exec bun run "${HOME:?}/leo_internal/dev-servers/leo-server/caddy/install/leoProjectRegistryInstallCli.ts" "$@"
