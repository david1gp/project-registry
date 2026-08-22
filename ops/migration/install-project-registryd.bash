#!/usr/bin/env bash
set -euo pipefail

# Preparation-only installer. It deliberately does not control the service manager;
# identity discovery is read-only.

umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SOURCE_DIR="${PROJECT_REGISTRY_SOURCE:-$(cd "$SCRIPT_DIR/../.." && pwd)}"
INSTALL_ROOT="${PROJECT_REGISTRY_INSTALL_ROOT:-/home/caddy/project-registry}"
CONFIG_ROOT="${PROJECT_REGISTRY_CONFIG_ROOT:-/etc/project-registry}"
UNIT_PATH="${PROJECT_REGISTRY_UNIT_PATH:-/etc/systemd/system/project-registryd.service}"
OIDC_SOURCE="${PROJECT_REGISTRY_OIDC_SOURCE:-/home/david/leo/leo-server/caddy/oidc/leonardomora.oidc.env}"
OIDC_TARGET="${PROJECT_REGISTRY_OIDC_TARGET:-$CONFIG_ROOT/leonardomora.oidc.env}"
ZITADEL_SOURCE="${PROJECT_REGISTRY_ZITADEL_SOURCE:-}"
ZITADEL_TARGET="${PROJECT_REGISTRY_ZITADEL_TARGET:-$CONFIG_ROOT/zitadel.env}"
REPOSITORY_PATH="${PROJECT_REGISTRY_REPOSITORY_PATH:-/home/caddy/project-registry-history}"
CADDY_BINARY_PATH="${PROJECT_REGISTRY_CADDY_BINARY:-/home/caddy/.local/bin/caddy}"
BUN_BIN="${BUN_BIN:-}"
INSTALL_BIN="${INSTALL_BIN:-install}"
PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT="${PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT:-}"
PROJECT_REGISTRY_BUN_RUNTIME_PATH="${PROJECT_REGISTRY_BUN_RUNTIME_PATH:-/usr/local/bin/project-registry-bun}"
CADDY_USER="${CADDY_USER:-}"
CADDY_GROUP="${CADDY_GROUP:-}"
DRY_RUN=1

# Read-only identity discovery; the source file/output variables are test/offline injection points.
# shellcheck source=/dev/null
source "$SCRIPT_DIR/caddy-service-identity.bash"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/caddy-access-log-permissions.bash"

usage() {
  cat <<'USAGE'
Usage: install-project-registryd.bash [--dry-run|--apply]

Builds the library daemon with the package's `bun run build:lib` command and
stages its runtime, environment, OIDC environment, and systemd unit. The
default is --dry-run. --apply installs files only; service activation is
intentionally left to the later cutover task.

Environment:
  PROJECT_REGISTRY_SOURCE  checkout to build (default: repository root)
  PROJECT_REGISTRY_INSTALL_ROOT  runtime destination (default: /home/caddy/project-registry)
  PROJECT_REGISTRY_CONFIG_ROOT   config destination (default: /etc/project-registry)
  PROJECT_REGISTRY_UNIT_PATH     unit destination (default: /etc/systemd/system/project-registryd.service)
  PROJECT_REGISTRY_OIDC_SOURCE   existing Leo OIDC env (default: Leo checkout path)
  PROJECT_REGISTRY_OIDC_TARGET   copied OIDC env destination (default: config root)
  PROJECT_REGISTRY_ZITADEL_SOURCE  optional separately provisioned Zitadel env to copy
  PROJECT_REGISTRY_ZITADEL_TARGET  required Zitadel env destination (default: config root/zitadel.env)
  PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT  opt-in Caddy access-log root (unset disables logging)
  CADDY_USER/CADDY_GROUP  optional expected identity; it must exactly match caddy.service
  CADDY_SERVICE_IDENTITY_FILE  read-only identity fixture for tests/offline preparation
  CADDY_SERVICE_IDENTITY_OUTPUT  injected systemctl-show output for tests/offline preparation
  CADDY_SYSTEMCTL          read-only systemctl executable (default: systemctl)
  PROJECT_REGISTRY_REPOSITORY_PATH  migrated Git repository (default: /home/caddy/project-registry-history)
  PROJECT_REGISTRY_CADDY_BINARY  system Caddy binary (default: /home/caddy/.local/bin/caddy)
  BUN_BIN                  explicit, executable Bun source to stage
  INSTALL_BIN              install executable (default: install)
  PROJECT_REGISTRY_BUN_RUNTIME_PATH  root-owned stable Bun destination (default: /usr/local/bin/project-registry-bun)
USAGE
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      DRY_RUN=1
      ;;
    --apply)
      DRY_RUN=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

[[ -d "$SOURCE_DIR" ]] || { printf 'missing source directory: %s\n' "$SOURCE_DIR" >&2; exit 1; }
[[ -f "$SOURCE_DIR/package.json" ]] || { printf 'missing package.json in: %s\n' "$SOURCE_DIR" >&2; exit 1; }
[[ -f "$SCRIPT_DIR/project-registryd.service" ]] || { printf 'missing service template\n' >&2; exit 1; }
[[ -f "$SCRIPT_DIR/project-registryd.env" ]] || { printf 'missing environment template\n' >&2; exit 1; }
[[ -r "$OIDC_SOURCE" ]] || { printf 'missing or unreadable OIDC environment: %s\n' "$OIDC_SOURCE" >&2; exit 1; }
if [[ -n "$ZITADEL_SOURCE" ]]; then
  [[ -f "$ZITADEL_SOURCE" && ! -L "$ZITADEL_SOURCE" && -r "$ZITADEL_SOURCE" ]] || {
    printf 'missing or unreadable Zitadel environment: %s\n' "$ZITADEL_SOURCE" >&2
    exit 1
  }
fi

[[ -n "$INSTALL_ROOT" && "$INSTALL_ROOT" != / ]] || { printf 'invalid runtime destination\n' >&2; exit 1; }
[[ -n "$CONFIG_ROOT" && "$CONFIG_ROOT" != / ]] || { printf 'invalid config destination\n' >&2; exit 1; }
[[ -n "$UNIT_PATH" && "$UNIT_PATH" != / ]] || { printf 'invalid unit destination\n' >&2; exit 1; }
[[ -n "$REPOSITORY_PATH" && "$REPOSITORY_PATH" != *$'\n'* ]] || { printf 'invalid repository path\n' >&2; exit 1; }
[[ -n "$CADDY_BINARY_PATH" && "$CADDY_BINARY_PATH" != *$'\n'* ]] || { printf 'invalid Caddy binary path\n' >&2; exit 1; }
[[ -n "$OIDC_TARGET" && "$OIDC_TARGET" != *$'\n'* ]] || { printf 'invalid OIDC destination\n' >&2; exit 1; }
[[ -n "$ZITADEL_TARGET" && "$ZITADEL_TARGET" != *$'\n'* ]] || { printf 'invalid Zitadel destination\n' >&2; exit 1; }
[[ -n "$PROJECT_REGISTRY_BUN_RUNTIME_PATH" && "$PROJECT_REGISTRY_BUN_RUNTIME_PATH" == /* && "$PROJECT_REGISTRY_BUN_RUNTIME_PATH" != *$'\n'* ]] || {
  printf 'invalid Bun runtime path\n' >&2
  exit 1
}

path_is_within() {
  local root="$1"
  local path="$2"
  if [[ "$root" == "/" ]]; then
    [[ "$path" == /* ]]
    return
  fi
  [[ "$path" == "$root" || "$path" == "$root/"* ]]
}

if [[ -n "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" ]]; then
  [[ "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" == /* ]] || {
    printf 'Caddy access-log root must be absolute\n' >&2
    exit 1
  }
  [[ "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" != / && "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" != */ && \
    "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" != *$'\n'* && "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" != *\\* ]] || {
    printf 'invalid Caddy access-log root\n' >&2
    exit 1
  }
  access_log_root_realpath="$(realpath -m "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT")"
  [[ "$access_log_root_realpath" == "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" ]] || {
    printf 'Caddy access-log root must be normalized: %s\n' "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" >&2
    exit 1
  }
  repository_realpath="$(realpath -m "$REPOSITORY_PATH")"
  if path_is_within "$repository_realpath" "$access_log_root_realpath"; then
    printf 'Caddy access-log root must not be inside the Git repository: %s\n' "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" >&2
    exit 1
  fi
fi

command -v "$INSTALL_BIN" >/dev/null 2>&1 || {
  printf 'missing install: %s\n' "$INSTALL_BIN" >&2
  exit 1
}

if [[ -z "$BUN_BIN" ]]; then
  printf 'BUN_BIN is required; set it to an explicit absolute Bun executable\n' >&2
  exit 1
fi
if [[ "$BUN_BIN" != /* || ! -f "$BUN_BIN" || ! -x "$BUN_BIN" ]]; then
  printf 'BUN_BIN must be an executable absolute path: %s\n' "$BUN_BIN" >&2
  exit 1
fi

caddy_service_identity_load

if [[ "$DRY_RUN" -eq 1 ]]; then
  printf 'dry-run: authoritative caddy.service identity is %s:%s\n' "$CADDY_USER" "$CADDY_GROUP"
  printf 'dry-run: would verify and build with %s run build:lib in %s\n' "$BUN_BIN" "$SOURCE_DIR"
  printf 'dry-run: would stage Bun as %s (root:root, mode 0755)\n' "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"
  printf 'dry-run: would install runtime into %s\n' "$INSTALL_ROOT"
  printf 'dry-run: would install environment into %s/project-registryd.env (mode 0640)\n' "$CONFIG_ROOT"
  printf 'dry-run: would map OIDC environment %s to %s (root-owned mode 0600)\n' "$OIDC_SOURCE" "$OIDC_TARGET"
  if [[ -n "$ZITADEL_SOURCE" ]]; then
    printf 'dry-run: would map separately provisioned Zitadel environment to %s (root-owned mode 0600)\n' "$ZITADEL_TARGET"
  else
    printf 'dry-run: would retain separately provisioned Zitadel environment at %s (required before activation)\n' "$ZITADEL_TARGET"
  fi
  if [[ -n "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" ]]; then
     printf 'dry-run: would provision Caddy access-log root %s (%s:%s, directories 0700)\n' \
       "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" "$CADDY_USER" "$CADDY_GROUP"
      printf 'dry-run: existing access-log files and metadata would be left untouched\n'
  else
    printf 'dry-run: Caddy access logging remains disabled (PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT is unset)\n'
  fi
  printf 'dry-run: would install unit into %s (mode 0644), repository=%s, Caddy=%s\n' "$UNIT_PATH" "$REPOSITORY_PATH" "$CADDY_BINARY_PATH"
  printf 'dry-run: no service operation will be performed\n'
  exit 0
fi

if [[ "$(id -u)" -ne 0 ]]; then
  printf '--apply must run as root so it can install under /etc and /home/caddy\n' >&2
  exit 1
fi
"$BUN_BIN" --version >/dev/null 2>&1 || {
  printf 'BUN_BIN is not a runnable Bun executable: %s\n' "$BUN_BIN" >&2
  exit 1
}

(
  cd "$SOURCE_DIR"
  "$BUN_BIN" run build:lib
)
[[ -d "$SOURCE_DIR/dist" ]] || { printf 'build did not produce dist\n' >&2; exit 1; }
[[ -d "$SOURCE_DIR/node_modules" ]] || {
  printf 'node_modules is required by the unbundled daemon runtime\n' >&2
  exit 1
}

"$INSTALL_BIN" -d -o root -g root -m 0755 "$INSTALL_ROOT" "$CONFIG_ROOT" "$(dirname "$UNIT_PATH")" "$(dirname "$OIDC_TARGET")" "$(dirname "$ZITADEL_TARGET")"
if [[ -n "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" ]]; then
  caddy_access_log_root_prepare "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" "$CADDY_USER" "$CADDY_GROUP" || exit 1
fi
rm -rf "$INSTALL_ROOT/dist" "$INSTALL_ROOT/node_modules"
cp -a "$SOURCE_DIR/dist" "$INSTALL_ROOT/dist"
cp -a "$SOURCE_DIR/node_modules" "$INSTALL_ROOT/node_modules"
"$INSTALL_BIN" -o root -g root -m 0644 "$SOURCE_DIR/package.json" "$INSTALL_ROOT/package.json"
chown -R root:root "$INSTALL_ROOT"
bun_runtime_directory="$(dirname "$PROJECT_REGISTRY_BUN_RUNTIME_PATH")"
[[ ! -L "$PROJECT_REGISTRY_BUN_RUNTIME_PATH" ]] || {
  printf 'Bun runtime destination must not be a symbolic link: %s\n' "$PROJECT_REGISTRY_BUN_RUNTIME_PATH" >&2
  exit 1
}
"$INSTALL_BIN" -d -o root -g root -m 0755 "$bun_runtime_directory"
chown root:root "$bun_runtime_directory"
chmod 0755 "$bun_runtime_directory"
if [[ "$(realpath "$BUN_BIN")" != "$(realpath -m "$PROJECT_REGISTRY_BUN_RUNTIME_PATH")" ]]; then
  "$INSTALL_BIN" -o root -g root -m 0755 "$BUN_BIN" "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"
else
  chown root:root "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"
  chmod 0755 "$PROJECT_REGISTRY_BUN_RUNTIME_PATH"
fi

environment_stage="$(mktemp)"
oidc_stage="$(mktemp)"
unit_stage="$(mktemp)"
cleanup_staging() {
  rm -f "$environment_stage" "$oidc_stage" "$unit_stage"
}
trap cleanup_staging EXIT

normalize_oidc_environment() {
  local output="$1"
  (
    set +u
    unset PROJECT_REGISTRY_OIDC_ISSUER PROJECT_REGISTRY_OIDC_PROVIDER PROJECT_REGISTRY_OIDC_CLIENT_ID \
      PROJECT_REGISTRY_OIDC_CLIENT_SECRET PROJECT_REGISTRY_OIDC_COOKIE_SECRET \
      CADDY_PROJECTS_OIDC_ISSUER CADDY_PROJECTS_OIDC_PROVIDER CADDY_PROJECTS_OIDC_CLIENT_ID \
      CADDY_PROJECTS_OIDC_CLIENT_SECRET CADDY_PROJECTS_OIDC_COOKIE_SECRET \
      LEONARDOMORA_OIDC_ISSUER LEONARDOMORA_OIDC_PROVIDER LEONARDOMORA_OIDC_CLIENT_ID \
      LEONARDOMORA_OIDC_CLIENT_SECRET COOKIE_SECRET
    # shellcheck source=/dev/null
    source "$OIDC_SOURCE" >/dev/null 2>&1

    local issuer="${PROJECT_REGISTRY_OIDC_ISSUER:-${CADDY_PROJECTS_OIDC_ISSUER:-${LEONARDOMORA_OIDC_ISSUER:-https://auth.contentoren.de}}}"
    local provider="${PROJECT_REGISTRY_OIDC_PROVIDER:-${CADDY_PROJECTS_OIDC_PROVIDER:-${LEONARDOMORA_OIDC_PROVIDER:-zitadel}}}"
    local client_id="${PROJECT_REGISTRY_OIDC_CLIENT_ID:-${CADDY_PROJECTS_OIDC_CLIENT_ID:-${LEONARDOMORA_OIDC_CLIENT_ID:-}}}"
    local client_secret="${PROJECT_REGISTRY_OIDC_CLIENT_SECRET:-${CADDY_PROJECTS_OIDC_CLIENT_SECRET:-${LEONARDOMORA_OIDC_CLIENT_SECRET:-}}}"
    local cookie_secret="${PROJECT_REGISTRY_OIDC_COOKIE_SECRET:-${CADDY_PROJECTS_OIDC_COOKIE_SECRET:-${COOKIE_SECRET:-}}}"

    [[ -n "$client_id" ]] || { printf 'OIDC environment is missing a client ID\n' >&2; exit 1; }
    [[ -n "$client_secret" ]] || { printf 'OIDC environment is missing a client secret\n' >&2; exit 1; }
    [[ -n "$cookie_secret" ]] || { printf 'OIDC environment is missing a cookie secret\n' >&2; exit 1; }

    umask 077
    {
      printf '%s\n' \
        '# Normalized OIDC settings for project-registryd.' \
        '# Generated from the existing Leo OIDC environment; values are secret.'
      printf 'PROJECT_REGISTRY_OIDC_ISSUER=%s\n' "$issuer"
      printf 'PROJECT_REGISTRY_OIDC_PROVIDER=%s\n' "$provider"
      printf 'PROJECT_REGISTRY_OIDC_CLIENT_ID=%s\n' "$client_id"
      printf 'PROJECT_REGISTRY_OIDC_CLIENT_SECRET=%s\n' "$client_secret"
      printf 'PROJECT_REGISTRY_OIDC_COOKIE_SECRET=%s\n' "$cookie_secret"
      printf 'CADDY_PROJECTS_OIDC_ISSUER=%s\n' "$issuer"
      printf 'CADDY_PROJECTS_OIDC_PROVIDER=%s\n' "$provider"
      printf 'CADDY_PROJECTS_OIDC_CLIENT_ID=%s\n' "$client_id"
      printf 'CADDY_PROJECTS_OIDC_CLIENT_SECRET=%s\n' "$client_secret"
      printf 'CADDY_PROJECTS_OIDC_COOKIE_SECRET=%s\n' "$cookie_secret"
    } > "$output"
  )
  chmod 0600 "$output"
}

printf '%s\n' \
  '# Non-secret production settings for project-registryd.' \
  '# Normalized OIDC values are staged separately from the non-secret settings.' \
  "PROJECT_REGISTRY_REPOSITORY_PATH=$REPOSITORY_PATH" \
  'PROJECT_REGISTRY_REPOSITORY_BRANCH=main' \
  'PROJECT_REGISTRY_USERS=leo,david' \
  'PROJECT_REGISTRY_SOCKET_DIRECTORY=/run/project-registry' \
  'PROJECT_REGISTRY_WEB_HOST=127.0.0.1' \
  'PROJECT_REGISTRY_WEB_PORT=8080' \
  "PROJECT_REGISTRY_CADDY_BINARY=$CADDY_BINARY_PATH" \
  'PROJECT_REGISTRY_CADDY_ADMIN_URL=http://127.0.0.1:2019' \
  'PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG=true' \
  'PROJECT_REGISTRY_HTTPS_LISTENER=:443' \
  'PROJECT_REGISTRY_PORT_FROM=3000' \
  'PROJECT_REGISTRY_PORT_TO=3999' \
  'PROJECT_REGISTRY_GIT_PUSH=false' \
  > "$environment_stage"
if [[ -n "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" ]]; then
  printf 'PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT=%s\n' "$PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT" >> "$environment_stage"
  printf 'CADDY_USER=%s\n' "$CADDY_USER" >> "$environment_stage"
  printf 'CADDY_GROUP=%s\n' "$CADDY_GROUP" >> "$environment_stage"
fi
"$INSTALL_BIN" -o root -g root -m 0640 "$environment_stage" "$CONFIG_ROOT/project-registryd.env"
normalize_oidc_environment "$oidc_stage"
"$INSTALL_BIN" -o root -g root -m 0600 "$oidc_stage" "$OIDC_TARGET"
if [[ -n "$ZITADEL_SOURCE" ]]; then
  "$INSTALL_BIN" -o root -g root -m 0600 "$ZITADEL_SOURCE" "$ZITADEL_TARGET"
fi
sed \
  -e "s|/etc/project-registry/project-registryd.env|$CONFIG_ROOT/project-registryd.env|g" \
  -e "s|/etc/project-registry/leonardomora.oidc.env|$OIDC_TARGET|g" \
  -e "s|/etc/project-registry/zitadel.env|$ZITADEL_TARGET|g" \
  -e "s|/home/caddy/project-registry|$INSTALL_ROOT|g" \
  -e "s|/home/caddy/.local/bin/caddy|$CADDY_BINARY_PATH|g" \
  -e "s|/usr/local/bin/project-registry-bun|$PROJECT_REGISTRY_BUN_RUNTIME_PATH|g" \
  "$SCRIPT_DIR/project-registryd.service" > "$unit_stage"
"$INSTALL_BIN" -o root -g root -m 0644 "$unit_stage" "$UNIT_PATH"

printf 'Installed project-registryd files without activating a service.\n'
printf 'Next preparation checks: systemd-analyze verify %s; verify Caddy access-log ownership/modes if enabled\n' "$UNIT_PATH"
