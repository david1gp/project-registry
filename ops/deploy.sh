#!/usr/bin/env bash
set -euo pipefail

exec bun run "${HOME:?}/leo_internal/dev-servers/wonder1-server/caddy/install/wonder1ProjectRegistryInstallCli.ts" "$@"
