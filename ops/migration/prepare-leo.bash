#!/usr/bin/env bash
set -euo pipefail

# Preparation only. This script deliberately never contacts systemd or loads a
# Caddy configuration through the admin API. It only reads /config/ when apply
# needs a live parity baseline; task 4 validates the candidate on stdin.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DRY_RUN=1
APPLY_SEEN=0
DRY_RUN_SEEN=0

PROJECT_REGISTRY_SOURCE=""
LEGACY_REPOSITORY=""
MIGRATED_REPOSITORY=""
SOFTWARE_PROJECTS=""
SOFTWARE_OWNER=""
NAME_MAPPING=""
LEGACY_CADDY_CONFIG=""
CADDY_ADMIN_URL="${CADDY_ADMIN_URL:-http://127.0.0.1:2019/config/}"
CANDIDATE_OUTPUT=""
OIDC_SOURCE=""
CADDY_DATA_DESTINATION=""
CADDY_BACKUP_ROOT=""
CADDY_BINARY_SOURCE=""
CADDY_BINARY_DESTINATION=""
CADDY_UNIT_SOURCE=""
CADDY_UNIT_DESTINATION=""
CADDY_CONFIG_DESTINATION=""
CADDY_CONFIG_STAGE=""
CADDY_UNIT_STAGE=""
CADDY_UMASK_DROPIN_SOURCE="${CADDY_UMASK_DROPIN_SOURCE:-$SCRIPT_DIR/caddy.service.d/10-project-registry-umask.conf}"
CADDY_UMASK_DROPIN_STAGE="${CADDY_UMASK_DROPIN_STAGE:-}"
CADDY_UMASK_DROPIN_DESTINATION="${CADDY_UMASK_DROPIN_DESTINATION:-}"
CADDY_OIDC_DESTINATION=""
CADDY_OIDC_ALIAS_DESTINATION=""
PROJECT_REGISTRY_INSTALL_ROOT=""
PROJECT_REGISTRY_CONFIG_ROOT=""
PROJECT_REGISTRY_UNIT_DESTINATION=""
BUN_BIN="${BUN_BIN:-}"
INSTALL_BIN="${INSTALL_BIN:-install}"
SETCAP_BIN="${SETCAP_BIN:-}"
GETCAP_BIN="${GETCAP_BIN:-}"
SYSTEMD_ANALYZE_BIN="${SYSTEMD_ANALYZE_BIN:-systemd-analyze}"
CADDY_USER="${CADDY_USER:-}"
CADDY_GROUP="${CADDY_GROUP:-}"
CADDY_WORKING_DIRECTORY="${CADDY_WORKING_DIRECTORY:-/home/caddy}"
CADDY_ACCESS_COMMAND="${CADDY_ACCESS_COMMAND:-/usr/sbin/runuser}"

# shellcheck source=/dev/null
source "$SCRIPT_DIR/caddy-service-identity.bash"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/caddy-access-log-permissions.bash"
# shellcheck source=/dev/null
source "$SCRIPT_DIR/caddy-umask-dropin.bash"

usage() {
  cat <<'USAGE'
Usage:
  bash ops/migration/prepare-leo.bash [--dry-run|--apply] \
    --project-registry-source PATH \
    --legacy-repository PATH --migrated-repository PATH \
    --software-projects PATH --software-owner OWNER [--name-mapping PATH] \
    [--legacy-caddy-config PATH] --candidate-output PATH \
    [--caddy-admin-url URL] \
    --oidc-source PATH \
    --caddy-data-destination PATH --caddy-backup-root PATH \
    --caddy-binary-source PATH --caddy-binary-destination PATH \
    --caddy-unit-source PATH --caddy-unit-destination PATH \
    --caddy-config-destination PATH --caddy-config-stage PATH \
    --caddy-unit-stage PATH \
    --caddy-oidc-destination PATH --caddy-oidc-alias-destination PATH \
    --project-registry-install-root PATH \
    --project-registry-config-root PATH \
    --project-registry-unit-destination PATH

The default is --dry-run. --apply captures the live Caddy /config/ response,
migrates the repository, generates a candidate, and completes parity, dependency
preflight, and stdin-only Caddy validation before it creates any backup, install, or stage
files. A non-colliding backup of the live Caddy data, JSON, unit, OIDC environment files, and captured
baseline is then created. All source and destination paths are required because
this command is intended for an explicitly reviewed Leo host preparation.

Preparation does not start, stop, enable, restart, reload, or otherwise
activate a service. It only performs a GET of the loopback /config/ endpoint
for the live baseline and never loads a config through the admin API or runs
Caddy with the public listener; validation receives JSON on stdin only.

Options:
  --dry-run                         Print the exact preparation plan (default)
  --apply                           Build, stage, migrate, generate, and validate
  --project-registry-source PATH    Project Registry checkout to build
  --legacy-repository PATH          Existing Git history repository to read without changing
  --migrated-repository PATH        Separate Git destination for the converted records
  --software-projects PATH          Existing Leo Software project records
  --software-owner OWNER            Owner for the Software records
  --name-mapping PATH               Optional JSON mapping for Software names
  --legacy-caddy-config PATH        Offline parity baseline override (read-only)
  --caddy-admin-url URL             Loopback Caddy /config/ URL (default: http://127.0.0.1:2019/config/)
  --caddy-user USER                 Expected Caddy user; must match caddy.service exactly
  --caddy-group GROUP               Expected Caddy group; must match caddy.service exactly
  --caddy-working-directory PATH    Caddy working directory for relative dependency paths (default: /home/caddy)
  --caddy-access-command PATH       Safe user-switch command (default: /usr/sbin/runuser; use none only for test/offline fallback)
  --candidate-output PATH            Candidate JSON output path
  --oidc-source PATH                Existing Leo OIDC env file (read-only)
  --caddy-data-destination PATH     Existing authoritative system Caddy data directory (read-only)
  --caddy-backup-root PATH          Root for timestamped live Caddy state backups
  --caddy-binary-source PATH        Existing OIDC-capable Caddy binary
  --caddy-binary-destination PATH   System Caddy binary path
  --caddy-unit-source PATH          Leo system Caddy unit template
  --caddy-unit-destination PATH     Existing live system Caddy unit (read-only)
  --caddy-config-destination PATH   Existing live system Caddy JSON (read-only)
  --caddy-config-stage PATH         Separate candidate Caddy JSON stage path
    --caddy-unit-stage PATH            Separate candidate Caddy unit stage path
     --caddy-umask-dropin-source PATH  Reviewed authoritative Caddy UMask drop-in
     --caddy-umask-dropin-stage PATH   Separate drop-in stage path
     --caddy-umask-dropin-destination PATH  Existing authoritative drop-in to back up
  --caddy-oidc-destination PATH     System Caddy OIDC env destination
  --caddy-oidc-alias-destination PATH  Second env path used by the existing Caddy unit
  --project-registry-install-root PATH  project-registry runtime destination
  --project-registry-config-root PATH   project-registry config destination
    --project-registry-unit-destination PATH  project-registryd unit destination
  --help                            Show this help

Environment:
  BUN_BIN, INSTALL_BIN, SETCAP_BIN, GETCAP_BIN may override host tools.
  SYSTEMD_ANALYZE_BIN may override systemd-analyze for fixtures.
  CADDY_SERVICE_IDENTITY_FILE may inject a read-only User=/Group= fixture for tests.
  CADDY_SERVICE_IDENTITY_OUTPUT may inject systemctl-show output for tests.
USAGE
}

argument_value() {
  local option="$1"
  local value="${2:-}"
  if [[ -z "$value" || "$value" == --* ]]; then
    printf '%s needs a value\n' "$option" >&2
    exit 2
  fi
  printf '%s' "$value"
}

while (($# > 0)); do
  case "$1" in
    --dry-run)
      DRY_RUN_SEEN=1
      DRY_RUN=1
      ;;
    --apply)
      APPLY_SEEN=1
      DRY_RUN=0
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    --project-registry-source)
      PROJECT_REGISTRY_SOURCE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --legacy-repository)
      LEGACY_REPOSITORY="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --migrated-repository|--destination-repository)
      MIGRATED_REPOSITORY="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --software-projects)
      SOFTWARE_PROJECTS="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --software-owner)
      SOFTWARE_OWNER="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --name-mapping)
      NAME_MAPPING="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --legacy-caddy-config)
      LEGACY_CADDY_CONFIG="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-admin-url|--caddy-admin-config-url)
      CADDY_ADMIN_URL="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-user)
      CADDY_USER="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-group)
      CADDY_GROUP="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-working-directory)
      CADDY_WORKING_DIRECTORY="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-access-command)
      CADDY_ACCESS_COMMAND="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --candidate-output)
      CANDIDATE_OUTPUT="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --oidc-source)
      OIDC_SOURCE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-data-destination)
      CADDY_DATA_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-backup-root)
      CADDY_BACKUP_ROOT="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-binary-source)
      CADDY_BINARY_SOURCE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-binary-destination)
      CADDY_BINARY_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-unit-source)
      CADDY_UNIT_SOURCE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-unit-destination)
      CADDY_UNIT_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-config-destination)
      CADDY_CONFIG_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-config-stage)
      CADDY_CONFIG_STAGE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-unit-stage)
      CADDY_UNIT_STAGE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-umask-dropin-source)
      CADDY_UMASK_DROPIN_SOURCE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-umask-dropin-stage)
      CADDY_UMASK_DROPIN_STAGE="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-umask-dropin-destination)
      CADDY_UMASK_DROPIN_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-oidc-destination)
      CADDY_OIDC_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --caddy-oidc-alias-destination)
      CADDY_OIDC_ALIAS_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --project-registry-install-root)
      PROJECT_REGISTRY_INSTALL_ROOT="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --project-registry-config-root)
      PROJECT_REGISTRY_CONFIG_ROOT="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    --project-registry-unit-destination)
      PROJECT_REGISTRY_UNIT_DESTINATION="$(argument_value "$1" "${2:-}")"
      shift
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$APPLY_SEEN" -eq 1 && "$DRY_RUN_SEEN" -eq 1 ]]; then
  printf '%s\n' '--apply and --dry-run are mutually exclusive' >&2
  exit 2
fi

required_option() {
  local option="$1"
  local value="$2"
  if [[ -z "$value" ]]; then
    printf '%s is required\n' "$option" >&2
    exit 2
  fi
}

required_option --project-registry-source "$PROJECT_REGISTRY_SOURCE"
required_option --legacy-repository "$LEGACY_REPOSITORY"
required_option --migrated-repository "$MIGRATED_REPOSITORY"
required_option --software-projects "$SOFTWARE_PROJECTS"
required_option --software-owner "$SOFTWARE_OWNER"
required_option --candidate-output "$CANDIDATE_OUTPUT"
required_option --oidc-source "$OIDC_SOURCE"
required_option --caddy-data-destination "$CADDY_DATA_DESTINATION"
required_option --caddy-backup-root "$CADDY_BACKUP_ROOT"
required_option --caddy-binary-source "$CADDY_BINARY_SOURCE"
required_option --caddy-binary-destination "$CADDY_BINARY_DESTINATION"
required_option --caddy-unit-source "$CADDY_UNIT_SOURCE"
required_option --caddy-unit-destination "$CADDY_UNIT_DESTINATION"
required_option --caddy-config-destination "$CADDY_CONFIG_DESTINATION"
required_option --caddy-config-stage "$CADDY_CONFIG_STAGE"
required_option --caddy-unit-stage "$CADDY_UNIT_STAGE"
required_option --caddy-oidc-destination "$CADDY_OIDC_DESTINATION"
required_option --caddy-oidc-alias-destination "$CADDY_OIDC_ALIAS_DESTINATION"
required_option --project-registry-install-root "$PROJECT_REGISTRY_INSTALL_ROOT"
required_option --project-registry-config-root "$PROJECT_REGISTRY_CONFIG_ROOT"
required_option --project-registry-unit-destination "$PROJECT_REGISTRY_UNIT_DESTINATION"

CADDY_UMASK_DROPIN_STAGE="${CADDY_UMASK_DROPIN_STAGE:-$CADDY_UNIT_STAGE.d/10-project-registry-umask.conf}"
CADDY_UMASK_DROPIN_DESTINATION="${CADDY_UMASK_DROPIN_DESTINATION:-$(dirname -- "$CADDY_UNIT_DESTINATION")/caddy.service.d/10-project-registry-umask.conf}"

if [[ "$DRY_RUN" -eq 0 ]]; then
  BUN_BIN="${BUN_BIN:-$(command -v bun || true)}"
  SETCAP_BIN="${SETCAP_BIN:-$(command -v setcap || true)}"
  [[ -n "$BUN_BIN" ]] || { printf 'bun is required for --apply\n' >&2; exit 1; }
fi

source_file_check() {
  local path="$1"
  [[ -f "$path" && -r "$path" ]] || { printf 'missing or unreadable file: %s\n' "$path" >&2; exit 1; }
}

directory_check() {
  local path="$1"
  [[ -d "$path" && -r "$path" ]] || { printf 'missing or unreadable directory: %s\n' "$path" >&2; exit 1; }
}

directory_check "$PROJECT_REGISTRY_SOURCE"
source_file_check "$PROJECT_REGISTRY_SOURCE/package.json"
source_file_check "$OIDC_SOURCE"
if [[ -n "$LEGACY_CADDY_CONFIG" ]]; then source_file_check "$LEGACY_CADDY_CONFIG"; fi
source_file_check "$CADDY_BINARY_SOURCE"
source_file_check "$CADDY_UNIT_SOURCE"
source_file_check "$CADDY_UMASK_DROPIN_SOURCE"
directory_check "$LEGACY_REPOSITORY"
directory_check "$SOFTWARE_PROJECTS"
directory_check "$CADDY_DATA_DESTINATION"
source_file_check "$CADDY_CONFIG_DESTINATION"
source_file_check "$CADDY_UNIT_DESTINATION"
if [[ -n "$NAME_MAPPING" ]]; then source_file_check "$NAME_MAPPING"; fi

if [[ "$DRY_RUN" -eq 0 ]]; then
  [[ -x "$CADDY_BINARY_SOURCE" ]] || { printf 'Caddy binary is not executable: %s\n' "$CADDY_BINARY_SOURCE" >&2; exit 1; }
  command -v "$INSTALL_BIN" >/dev/null || { printf 'missing install: %s\n' "$INSTALL_BIN" >&2; exit 1; }
fi

# The live unit is the default read-only source. Tests may replace it with a
# properties fixture or injected output; no service is started or reloaded.
CADDY_SERVICE_IDENTITY_FILE="${CADDY_SERVICE_IDENTITY_FILE:-$CADDY_UNIT_DESTINATION}"
caddy_service_identity_load
caddy_umask_dropin_validate "$CADDY_UMASK_DROPIN_SOURCE" || exit 1

CADDY_DATA_REALPATH="$(realpath -m "$CADDY_DATA_DESTINATION")"
CADDY_BACKUP_ROOT_REALPATH="$(realpath -m "$CADDY_BACKUP_ROOT")"
CADDY_CONFIG_REALPATH="$(realpath -m "$CADDY_CONFIG_DESTINATION")"
CADDY_CONFIG_STAGE_REALPATH="$(realpath -m "$CADDY_CONFIG_STAGE")"
CADDY_UNIT_REALPATH="$(realpath -m "$CADDY_UNIT_DESTINATION")"
CADDY_UNIT_STAGE_REALPATH="$(realpath -m "$CADDY_UNIT_STAGE")"
CADDY_UMASK_DROPIN_STAGE_REALPATH="$(realpath -m "$CADDY_UMASK_DROPIN_STAGE")"
CADDY_UMASK_DROPIN_DESTINATION_REALPATH="$(realpath -m "$CADDY_UMASK_DROPIN_DESTINATION")"
CANDIDATE_OUTPUT_REALPATH="$(realpath -m "$CANDIDATE_OUTPUT")"
CADDY_BINARY_SOURCE_REALPATH="$(realpath "$CADDY_BINARY_SOURCE")"
CADDY_BINARY_DESTINATION_REALPATH="$(realpath -m "$CADDY_BINARY_DESTINATION")"
CADDY_BINARY_SAME_FILE=0
if [[ "$CADDY_BINARY_SOURCE_REALPATH" == "$CADDY_BINARY_DESTINATION_REALPATH" ]]; then
  CADDY_BINARY_SAME_FILE=1
fi

if [[ "$DRY_RUN" -eq 0 && "$CADDY_BINARY_SAME_FILE" -eq 1 ]]; then
  GETCAP_BIN="${GETCAP_BIN:-$(command -v getcap || true)}"
  [[ -x "$GETCAP_BIN" ]] || { printf 'getcap is required to verify the live Caddy binary capabilities\n' >&2; exit 1; }
fi

live_caddy_execstart_binary() {
  local line
  local exec_start=""
  while IFS= read -r line || [[ -n "$line" ]]; do
    if [[ "$line" == ExecStart=* ]]; then
      exec_start="${line#ExecStart=}"
      break
    fi
  done < "$CADDY_UNIT_DESTINATION"

  exec_start="${exec_start#"${exec_start%%[![:space:]]*}"}"
  [[ -n "$exec_start" ]] || {
    printf 'live Caddy unit has no ExecStart binary: %s\n' "$CADDY_UNIT_DESTINATION" >&2
    exit 1
  }
  if [[ "$exec_start" == -* ]]; then exec_start="${exec_start#-}"; fi
  if [[ "$exec_start" == \"* ]]; then
    exec_start="${exec_start#\"}"
    printf '%s' "${exec_start%%\"*}"
  else
    printf '%s' "${exec_start%%[[:space:]]*}"
  fi
}

verify_caddy_capabilities() {
  local binary="$1"
  local capabilities
  capabilities="$($GETCAP_BIN "$binary" 2>/dev/null || true)"
  [[ "$capabilities" == *"cap_net_bind_service=ep"* ]] || {
    printf 'live Caddy binary lacks cap_net_bind_service=ep; refusing to modify it: %s\n' "$binary" >&2
    exit 1
  }
}

check_caddy_binary_safety() {
  if [[ "$CADDY_BINARY_SAME_FILE" -eq 1 ]]; then
    verify_caddy_capabilities "$CADDY_BINARY_SOURCE"
    return
  fi

  local live_caddy_execstart_realpath
  live_caddy_execstart_realpath="$(realpath -m "$(live_caddy_execstart_binary)")"
  if [[ "$CADDY_BINARY_DESTINATION_REALPATH" == "$live_caddy_execstart_realpath" ]]; then
    printf 'refusing Caddy binary replacement: %s is caddy.service ExecStart; Caddy replacement is outside this daemon migration\n' \
      "$CADDY_BINARY_DESTINATION" >&2
    exit 1
  fi
}

path_is_within() {
  local root="$1"
  local path="$2"
  [[ "$path" == "$root" || "$path" == "$root/"* ]]
}

reject_live_state_path() {
  local option="$1"
  local path="$2"
  local path_realpath
  path_realpath="$(realpath -m "$path")"
  if path_is_within "$CADDY_DATA_REALPATH" "$path_realpath" || \
    [[ "$path_realpath" == "$CADDY_CONFIG_REALPATH" || "$path_realpath" == "$CADDY_UNIT_REALPATH" ]]; then
    printf '%s must not target live Caddy state: %s\n' "$option" "$path" >&2
    exit 1
  fi
}

[[ "$CADDY_DATA_REALPATH" != "/" ]] || { printf 'refusing Caddy data destination /\n' >&2; exit 1; }
[[ "$CADDY_BACKUP_ROOT_REALPATH" != "/" ]] || { printf 'refusing Caddy backup root /\n' >&2; exit 1; }
if path_is_within "$CADDY_DATA_REALPATH" "$CADDY_BACKUP_ROOT_REALPATH"; then
  printf 'Caddy backup root must not be inside live Caddy data: %s\n' "$CADDY_BACKUP_ROOT" >&2
  exit 1
fi
if [[ "$CADDY_CONFIG_STAGE_REALPATH" == "$CADDY_CONFIG_REALPATH" || \
  "$CADDY_CONFIG_STAGE_REALPATH" == "$CADDY_UNIT_REALPATH" || \
  "$CADDY_UNIT_STAGE_REALPATH" == "$CADDY_CONFIG_REALPATH" || \
  "$CADDY_UNIT_STAGE_REALPATH" == "$CADDY_UNIT_REALPATH" || \
  "$CADDY_CONFIG_STAGE_REALPATH" == "$CADDY_UNIT_STAGE_REALPATH" || \
  "$CADDY_UMASK_DROPIN_STAGE_REALPATH" == "$CADDY_CONFIG_REALPATH" || \
  "$CADDY_UMASK_DROPIN_STAGE_REALPATH" == "$CADDY_UNIT_REALPATH" || \
  "$CADDY_UMASK_DROPIN_STAGE_REALPATH" == "$CADDY_CONFIG_STAGE_REALPATH" || \
  "$CADDY_UMASK_DROPIN_STAGE_REALPATH" == "$CADDY_UNIT_STAGE_REALPATH" || \
  "$CADDY_UMASK_DROPIN_STAGE_REALPATH" == "$CADDY_UMASK_DROPIN_DESTINATION_REALPATH" ]]; then
  printf 'Caddy candidate stage paths must be separate from live files and each other\n' >&2
  exit 1
fi
if path_is_within "$CADDY_DATA_REALPATH" "$CADDY_CONFIG_STAGE_REALPATH" || \
  path_is_within "$CADDY_DATA_REALPATH" "$CADDY_UNIT_STAGE_REALPATH" || \
  path_is_within "$CADDY_DATA_REALPATH" "$CADDY_UMASK_DROPIN_STAGE_REALPATH" || \
  path_is_within "$CADDY_DATA_REALPATH" "$CANDIDATE_OUTPUT_REALPATH"; then
  printf 'Caddy candidate paths must not be inside live Caddy data: %s\n' "$CADDY_DATA_DESTINATION" >&2
  exit 1
fi
if [[ "$CANDIDATE_OUTPUT_REALPATH" == "$CADDY_CONFIG_REALPATH" || \
  "$CANDIDATE_OUTPUT_REALPATH" == "$CADDY_UNIT_REALPATH" ]]; then
  printf '--candidate-output must not target a live Caddy file\n' >&2
  exit 1
fi
reject_live_state_path --caddy-binary-destination "$CADDY_BINARY_DESTINATION"
reject_live_state_path --caddy-oidc-destination "$CADDY_OIDC_DESTINATION"
reject_live_state_path --caddy-oidc-alias-destination "$CADDY_OIDC_ALIAS_DESTINATION"
reject_live_state_path --project-registry-install-root "$PROJECT_REGISTRY_INSTALL_ROOT"
reject_live_state_path --project-registry-unit-destination "$PROJECT_REGISTRY_UNIT_DESTINATION"

if [[ "$DRY_RUN" -eq 0 ]]; then
  check_caddy_binary_safety
  if [[ "$CADDY_BINARY_SAME_FILE" -eq 0 ]]; then
    [[ -x "$SETCAP_BIN" ]] || { printf 'setcap is required to stage a separate Caddy binary\n' >&2; exit 1; }
  fi
fi

backup_path_for_plan() {
  local base="$CADDY_BACKUP_ROOT/caddy-state-$(date -u +%Y%m%dT%H%M%SZ)"
  local candidate="$base"
  local suffix=1
  while [[ -e "$candidate" || -L "$candidate" ]]; do
    candidate="$base-$suffix"
    suffix=$((suffix + 1))
  done
  printf '%s' "$candidate"
}

CADDY_BACKUP_PLAN_PATH="$(backup_path_for_plan)"

print_plan() {
  printf 'mode: dry-run\n'
  printf 'would clone and migrate project history: %s -> %s\n' "$LEGACY_REPOSITORY" "$MIGRATED_REPOSITORY"
  printf 'would back up live Caddy data: %s -> %s/caddy-data\n' "$CADDY_DATA_DESTINATION" "$CADDY_BACKUP_PLAN_PATH"
  printf 'would back up live Caddy config: %s -> %s/caddy.json\n' "$CADDY_CONFIG_DESTINATION" "$CADDY_BACKUP_PLAN_PATH"
  printf 'would back up live Caddy unit: %s -> %s/caddy.service\n' "$CADDY_UNIT_DESTINATION" "$CADDY_BACKUP_PLAN_PATH"
  printf 'would back up existing live Caddy OIDC env files: %s -> %s/caddy-oidc.env; %s -> %s/caddy-oidc-alias.env\n' \
    "$CADDY_OIDC_DESTINATION" "$CADDY_BACKUP_PLAN_PATH" "$CADDY_OIDC_ALIAS_DESTINATION" "$CADDY_BACKUP_PLAN_PATH"
  if [[ -n "$LEGACY_CADDY_CONFIG" ]]; then
    printf 'would use offline legacy parity baseline: %s\n' "$LEGACY_CADDY_CONFIG"
  else
    printf 'would capture live Caddy JSON: %s -> temporary parity baseline\n' "$CADDY_ADMIN_URL"
  fi
  printf 'would back up the parity baseline: %s/caddy-admin-config.json\n' "$CADDY_BACKUP_PLAN_PATH"
  if [[ "$CADDY_BINARY_SAME_FILE" -eq 1 ]]; then
    printf 'would leave Caddy binary untouched and verify capabilities: %s\n' "$CADDY_BINARY_SOURCE"
  else
    printf 'would stage Caddy binary: %s -> %s\n' "$CADDY_BINARY_SOURCE" "$CADDY_BINARY_DESTINATION"
  fi
  printf 'would generate candidate Caddy config at: %s\n' "$CANDIDATE_OUTPUT"
  printf 'would stage candidate Caddy config: %s -> %s\n' "$CANDIDATE_OUTPUT" "$CADDY_CONFIG_STAGE"
  printf 'would stage candidate Caddy unit unchanged: %s -> %s\n' "$CADDY_UNIT_SOURCE" "$CADDY_UNIT_STAGE"
  printf 'would stage reviewed Caddy UMask drop-in: %s -> %s (UMask=0077, mode 0644)\n' "$CADDY_UMASK_DROPIN_SOURCE" "$CADDY_UMASK_DROPIN_STAGE"
  printf 'would back up authoritative Caddy UMask drop-in: %s\n' "$CADDY_UMASK_DROPIN_DESTINATION"
  printf 'would reuse OIDC env: %s -> %s and %s\n' "$OIDC_SOURCE" "$CADDY_OIDC_DESTINATION" "$CADDY_OIDC_ALIAS_DESTINATION"
  printf 'would run task-5 installer with runtime=%s config=%s unit=%s\n' \
    "$PROJECT_REGISTRY_INSTALL_ROOT" "$PROJECT_REGISTRY_CONFIG_ROOT" "$PROJECT_REGISTRY_UNIT_DESTINATION"
  printf 'would audit existing Caddy access logs, archives, and metadata without following links (bounded, safe-mode repair only)\n'
  printf 'would write candidate: %s\n' "$CANDIDATE_OUTPUT"
  printf 'would check dependencies as Caddy user=%s from working directory=%s with access-command=%s (missing filesystem paths and stopped backends warned)\n' \
    "$CADDY_USER:$CADDY_GROUP" "$CADDY_WORKING_DIRECTORY" "$CADDY_ACCESS_COMMAND"
  printf 'would run migration, candidate generation, task-4 semantic parity, task-6 dependency preflight, systemd-analyze, and stdin-only Caddy validation before writes\n'
  printf 'live Caddy data, config, and unit remain untouched\n'
  printf 'no files, services, public listeners, or Caddy config loads changed\n'
}

if [[ "$DRY_RUN" -eq 1 ]]; then
  print_plan
  exit 0
fi

access_log_root_preflight() {
  local root="${PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT:-}"
  [[ -z "$root" ]] && return 0
  caddy_access_log_audit_existing "$root" "$CADDY_USER" "$CADDY_GROUP" root root 1 1 || exit 1
  for directory in "$root" "$root/projects" "$root/quarantine"; do
    "$CADDY_ACCESS_COMMAND" -u "$CADDY_USER" -g "$CADDY_GROUP" -- test -r "$directory" || {
      printf 'Caddy cannot read access-log directory: %s\n' "$directory" >&2
      exit 1
    }
    "$CADDY_ACCESS_COMMAND" -u "$CADDY_USER" -g "$CADDY_GROUP" -- test -x "$directory" || {
      printf 'Caddy cannot traverse access-log directory: %s\n' "$directory" >&2
      exit 1
    }
  done
  "$CADDY_ACCESS_COMMAND" -u "$CADDY_USER" -g "$CADDY_GROUP" -- test -w "$root/projects" || {
    printf 'Caddy cannot create project access-log directories: %s\n' "$root/projects" >&2
    exit 1
  }
}

access_log_root_preflight

backup_live_caddy_state() {
  mkdir -p "$CADDY_BACKUP_ROOT"
  chmod 0700 "$CADDY_BACKUP_ROOT"

  local backup_path
  local backup_timestamp
  backup_timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup_path="$CADDY_BACKUP_ROOT/caddy-state-$backup_timestamp"
  local suffix=1
  while ! mkdir "$backup_path" 2>/dev/null; do
    backup_path="$CADDY_BACKUP_ROOT/caddy-state-$backup_timestamp-$suffix"
    suffix=$((suffix + 1))
  done
  chmod 0700 "$backup_path"
  cp -a "$CADDY_DATA_DESTINATION" "$backup_path/caddy-data"
  cp -a "$CADDY_CONFIG_DESTINATION" "$backup_path/caddy.json"
  find "$backup_path/caddy-data" -type d -exec chmod 0700 {} +
  chmod 0600 "$backup_path/caddy.json"
  cp -a "$CADDY_UNIT_DESTINATION" "$backup_path/caddy.service"
  if [[ -L "$CADDY_UMASK_DROPIN_DESTINATION" ]]; then
    printf 'authoritative Caddy UMask drop-in is a symbolic link: %s\n' "$CADDY_UMASK_DROPIN_DESTINATION" >&2
    return 1
  elif [[ -e "$CADDY_UMASK_DROPIN_DESTINATION" ]]; then
    [[ -f "$CADDY_UMASK_DROPIN_DESTINATION" ]] || {
      printf 'authoritative Caddy UMask drop-in is not a regular file: %s\n' "$CADDY_UMASK_DROPIN_DESTINATION" >&2
      return 1
    }
    cp --preserve=mode,ownership "$CADDY_UMASK_DROPIN_DESTINATION" "$backup_path/caddy-umask-dropin.conf"
  else
    : > "$backup_path/caddy-umask-dropin.absent"
    chmod 0600 "$backup_path/caddy-umask-dropin.absent"
  fi
  backup_oidc_environment "$CADDY_OIDC_DESTINATION" "$backup_path/caddy-oidc.env"
  backup_oidc_environment "$CADDY_OIDC_ALIAS_DESTINATION" "$backup_path/caddy-oidc-alias.env"
  CADDY_BACKUP_APPLY_PATH="$backup_path"
  printf 'created Caddy state backup: %s\n' "$backup_path"
}

stage_caddy_unit_unchanged() {
  local source="$1"
  local output="$2"
  cp -- "$source" "$output"
  chmod 0644 "$output"
}

verify_staged_caddy_unit_and_dropin() {
  local unit="$PREPARATION_TEMP/caddy.service"
  local dropin_directory="$unit.d"
  local dropin="$dropin_directory/10-project-registry-umask.conf"
  mkdir -p "$dropin_directory"
  stage_caddy_unit_unchanged "$CADDY_UNIT_SOURCE" "$unit"
  cp -- "$CADDY_UMASK_DROPIN_SOURCE" "$dropin"
  chmod 0644 "$dropin"
  caddy_umask_dropin_validate "$dropin" || exit 1
  caddy_umask_dropin_verify_unit "$unit" "$SYSTEMD_ANALYZE_BIN" || {
    printf 'systemd-analyze rejected staged authoritative caddy.service/drop-in\n' >&2
    exit 1
  }
}

backup_oidc_environment() {
  local source_path="$1"
  local backup_path="$2"
  if [[ -e "$source_path" || -L "$source_path" ]]; then
    [[ -f "$source_path" ]] || {
      printf 'live OIDC environment is not a regular file: %s\n' "$source_path" >&2
      return 1
    }
    (
      umask 077
      cp -- "$source_path" "$backup_path"
      chmod 0600 "$backup_path"
    )
  fi
}

PREPARATION_TEMP="$(mktemp -d "${TMPDIR:-/tmp}/project-registry-prepare.XXXXXX")"
cleanup_preparation() {
  rm -rf "$PREPARATION_TEMP"
}
trap cleanup_preparation EXIT

legacy_baseline_path=""
if [[ -n "$LEGACY_CADDY_CONFIG" ]]; then
  legacy_baseline_path="$LEGACY_CADDY_CONFIG"
else
  legacy_baseline_path="$PREPARATION_TEMP/caddy-admin-config.json"
  "$BUN_BIN" run "$SCRIPT_DIR/caddy-admin-config-capture.ts" \
    --url "$CADDY_ADMIN_URL" \
    --output "$legacy_baseline_path"
fi

load_project_registry_oidc_environment() {
  set -a
  # Candidate generation runs before the installer, so normalize the existing
  # Leo environment in memory and leave the installer to persist its copy.
  unset PROJECT_REGISTRY_OIDC_ISSUER PROJECT_REGISTRY_OIDC_PROVIDER PROJECT_REGISTRY_OIDC_CLIENT_ID \
    PROJECT_REGISTRY_OIDC_CLIENT_SECRET PROJECT_REGISTRY_OIDC_COOKIE_SECRET \
    CADDY_PROJECTS_OIDC_ISSUER CADDY_PROJECTS_OIDC_PROVIDER CADDY_PROJECTS_OIDC_CLIENT_ID \
    CADDY_PROJECTS_OIDC_CLIENT_SECRET CADDY_PROJECTS_OIDC_COOKIE_SECRET \
    LEONARDOMORA_OIDC_ISSUER LEONARDOMORA_OIDC_PROVIDER LEONARDOMORA_OIDC_CLIENT_ID \
    LEONARDOMORA_OIDC_CLIENT_SECRET COOKIE_SECRET
  # shellcheck source=/dev/null
  source "$OIDC_SOURCE" >/dev/null 2>&1
  PROJECT_REGISTRY_OIDC_ISSUER="${PROJECT_REGISTRY_OIDC_ISSUER:-${CADDY_PROJECTS_OIDC_ISSUER:-${LEONARDOMORA_OIDC_ISSUER:-https://auth.contentoren.de}}}"
  PROJECT_REGISTRY_OIDC_PROVIDER="${PROJECT_REGISTRY_OIDC_PROVIDER:-${CADDY_PROJECTS_OIDC_PROVIDER:-${LEONARDOMORA_OIDC_PROVIDER:-zitadel}}}"
  PROJECT_REGISTRY_OIDC_CLIENT_ID="${PROJECT_REGISTRY_OIDC_CLIENT_ID:-${CADDY_PROJECTS_OIDC_CLIENT_ID:-${LEONARDOMORA_OIDC_CLIENT_ID:-}}}"
  PROJECT_REGISTRY_OIDC_CLIENT_SECRET="${PROJECT_REGISTRY_OIDC_CLIENT_SECRET:-${CADDY_PROJECTS_OIDC_CLIENT_SECRET:-${LEONARDOMORA_OIDC_CLIENT_SECRET:-}}}"
  PROJECT_REGISTRY_OIDC_COOKIE_SECRET="${PROJECT_REGISTRY_OIDC_COOKIE_SECRET:-${CADDY_PROJECTS_OIDC_COOKIE_SECRET:-${COOKIE_SECRET:-}}}"
  set +a
}

migration_marker="$MIGRATED_REPOSITORY/migrations/legacy-v1.json"
if [[ -f "$migration_marker" ]]; then
  printf 'task-1 migration already completed: %s\n' "$migration_marker"
else
  migration_args=(
    run "$SCRIPT_DIR/legacy-migrate.ts"
    --repository "$LEGACY_REPOSITORY"
    --destination-repository "$MIGRATED_REPOSITORY"
    --software-projects "$SOFTWARE_PROJECTS"
    --software-owner "$SOFTWARE_OWNER"
    --apply
  )
  if [[ -n "$NAME_MAPPING" ]]; then migration_args+=(--name-mapping "$NAME_MAPPING"); fi
  "$BUN_BIN" "${migration_args[@]}"
fi

(
  load_project_registry_oidc_environment
  "$BUN_BIN" run "$SCRIPT_DIR/caddy-candidate-generate.ts" \
    --repository "$MIGRATED_REPOSITORY" \
    --output "$PREPARATION_TEMP/candidate.json"
)

(
  load_project_registry_oidc_environment
  "$BUN_BIN" run "$SCRIPT_DIR/caddy-semantic-parity.ts" \
    --legacy "$legacy_baseline_path" \
    --candidate "$PREPARATION_TEMP/candidate.json" \
    --caddy-bin "$CADDY_BINARY_SOURCE" \
    --caddy-user "$CADDY_USER" \
    --caddy-group "$CADDY_GROUP" \
    --caddy-access-command "$CADDY_ACCESS_COMMAND" \
    --validate \
    --json
)

dependency_preflight_args=(
  run "$SCRIPT_DIR/caddy-dependency-preflight.ts"
  --candidate "$PREPARATION_TEMP/candidate.json"
  --allow-missing-backends
  --allow-missing-filesystem
  --caddy-user "$CADDY_USER"
  --caddy-group "$CADDY_GROUP"
  --caddy-working-directory "$CADDY_WORKING_DIRECTORY"
)
if [[ -n "$CADDY_ACCESS_COMMAND" ]]; then dependency_preflight_args+=(--caddy-access-command "$CADDY_ACCESS_COMMAND"); fi
"$BUN_BIN" "${dependency_preflight_args[@]}"

verify_staged_caddy_unit_and_dropin

backup_live_caddy_state
cp -a "$legacy_baseline_path" "$CADDY_BACKUP_APPLY_PATH/caddy-admin-config.json"
chmod 0600 "$CADDY_BACKUP_APPLY_PATH/caddy-admin-config.json"

mkdir -p "$(dirname "$CANDIDATE_OUTPUT")" "$(dirname "$CADDY_CONFIG_STAGE")" "$(dirname "$CADDY_UNIT_STAGE")" "$(dirname "$CADDY_UMASK_DROPIN_STAGE")"
candidate_realpath="$(realpath -m "$CANDIDATE_OUTPUT")"
config_stage_realpath="$(realpath -m "$CADDY_CONFIG_STAGE")"
if [[ "$candidate_realpath" == "$config_stage_realpath" ]]; then
  "$INSTALL_BIN" -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0600 "$PREPARATION_TEMP/candidate.json" "$CANDIDATE_OUTPUT"
else
  "$INSTALL_BIN" -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0600 "$PREPARATION_TEMP/candidate.json" "$CANDIDATE_OUTPUT"
  "$INSTALL_BIN" -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0600 "$CANDIDATE_OUTPUT" "$CADDY_CONFIG_STAGE"
fi
stage_caddy_unit_unchanged "$CADDY_UNIT_SOURCE" "$CADDY_UNIT_STAGE"

if [[ "$CADDY_BINARY_SAME_FILE" -eq 0 ]]; then
  "$INSTALL_BIN" -d -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0755 "$(dirname "$CADDY_BINARY_DESTINATION")"
  "$INSTALL_BIN" -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0755 "$CADDY_BINARY_SOURCE" "$CADDY_BINARY_DESTINATION"
  "$SETCAP_BIN" cap_net_bind_service=+ep "$CADDY_BINARY_DESTINATION"
fi

"$INSTALL_BIN" -d -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0755 "$(dirname "$CADDY_OIDC_DESTINATION")" "$(dirname "$CADDY_OIDC_ALIAS_DESTINATION")"
"$INSTALL_BIN" -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0600 "$OIDC_SOURCE" "$CADDY_OIDC_DESTINATION"

PROJECT_REGISTRY_SOURCE="$PROJECT_REGISTRY_SOURCE" \
PROJECT_REGISTRY_INSTALL_ROOT="$PROJECT_REGISTRY_INSTALL_ROOT" \
PROJECT_REGISTRY_CONFIG_ROOT="$PROJECT_REGISTRY_CONFIG_ROOT" \
PROJECT_REGISTRY_UNIT_PATH="$PROJECT_REGISTRY_UNIT_DESTINATION" \
PROJECT_REGISTRY_OIDC_SOURCE="$OIDC_SOURCE" \
PROJECT_REGISTRY_REPOSITORY_PATH="$MIGRATED_REPOSITORY" \
PROJECT_REGISTRY_CADDY_BINARY="$CADDY_BINARY_DESTINATION" \
CADDY_USER="$CADDY_USER" \
CADDY_GROUP="$CADDY_GROUP" \
PROJECT_REGISTRY_CADDY_UMASK_DROPIN_SOURCE="$CADDY_UMASK_DROPIN_SOURCE" \
PROJECT_REGISTRY_CADDY_UMASK_DROPIN_TARGET="$CADDY_UMASK_DROPIN_STAGE" \
PROJECT_REGISTRY_CADDY_UNIT_FOR_VERIFY="$CADDY_UNIT_STAGE" \
CADDY_SERVICE_IDENTITY_OUTPUT="User=$CADDY_USER
Group=$CADDY_GROUP" \
  BUN_BIN="$BUN_BIN" \
  "$SCRIPT_DIR/install-project-registryd.bash" --apply

# Reuse the installer's normalized compatibility environment for the retained
# legacy daemon instead of maintaining a second persisted secret mapping here.
"$INSTALL_BIN" -o "$CADDY_USER" -g "$CADDY_GROUP" -m 0600 \
  "$PROJECT_REGISTRY_CONFIG_ROOT/leonardomora.oidc.env" "$CADDY_OIDC_ALIAS_DESTINATION"

printf 'Leo preparation staged successfully without activating services.\n'
