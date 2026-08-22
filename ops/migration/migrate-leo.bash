#!/usr/bin/env bash
set -euo pipefail

# Leo migration wrapper. Preparation remains in prepare-leo.bash; this command
# is the only migration-specific service switch. Rollback reloads the saved
# legacy native JSON through the already-running system Caddy admin API.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SYSTEMCTL_BIN="${SYSTEMCTL_BIN:-systemctl}"
OLD_PROJECTS_SERVICE="caddy-projects.service"
NEW_DAEMON_SERVICE="project-registryd.service"
CADDY_BINARY="${CADDY_BINARY:-${PROJECT_REGISTRY_CADDY_BINARY:-/home/caddy/.local/bin/caddy}}"
CADDY_CONFIG="${CADDY_CONFIG:-${CADDY_CONFIG_DESTINATION:-/home/caddy/.config/caddy/caddy.json}}"
CADDY_BACKUP="${CADDY_BACKUP:-}"
CADDY_ADMIN_URL="${CADDY_ADMIN_URL:-http://127.0.0.1:2019}"
CADDY_RELOAD_ADDRESS=""
CADDY_BACKUP_CONFIG=""
DRY_RUN=1
MODE_SEEN=0

usage() {
  cat <<'USAGE'
Usage:
  bash ops/migration/migrate-leo.bash prepare [--dry-run|--apply] [prepare options]
  sudo bash ops/migration/migrate-leo.bash cutover [--dry-run|--apply] [options]
  sudo bash ops/migration/migrate-leo.bash rollback [--dry-run|--apply] [options]

The default for every action is --dry-run. --apply is required for writes or
service changes. The prepare action delegates to prepare-leo.bash.

Cutover/rollback options:
  --old-projects-service UNIT    retained legacy daemon (default: caddy-projects.service)
  --new-daemon-service UNIT      staged project-registry daemon (default: project-registryd.service)
  --systemctl-bin PATH           systemctl executable (default: systemctl)
  --caddy-binary PATH             OIDC-capable Caddy binary for rollback
  --caddy-config PATH             live Caddy JSON file to persist the restored config
  --caddy-backup PATH              saved JSON or backup directory containing caddy-admin-config.json
  --caddy-admin-url ADDRESS        Caddy admin API address (default: http://127.0.0.1:2019)
  --dry-run                      print the ordered plan (default)
  --apply                        execute the ordered service changes
  --help                         show this help

The authoritative system caddy.service remains running and untouched. Only the
two system daemon units are swapped. Rollback validates the saved JSON offline,
reloads it through caddy.service's admin API, persists it at --caddy-config, and
then resumes the retained legacy daemon. It does not reverse project data or
Caddy certificates.
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

mode_option() {
  local option="$1"
  if [[ "$MODE_SEEN" -eq 1 ]]; then
    printf '%s and the other mode flag are mutually exclusive\n' "$option" >&2
    exit 2
  fi
  MODE_SEEN=1
  if [[ "$option" == "--apply" ]]; then
    DRY_RUN=0
  else
    DRY_RUN=1
  fi
}

valid_unit_name() {
  [[ "$1" =~ ^[A-Za-z0-9_.:@-]+$ ]]
}

print_command() {
  printf 'would run:'
  printf ' %q' "$@"
  printf '\n'
}

run_command() {
  printf 'run:'
  printf ' %q' "$@"
  printf '\n'
  "$@"
}

print_systemctl_command() {
  print_command "$SYSTEMCTL_BIN" "$@"
}

run_systemctl() {
  run_command "$SYSTEMCTL_BIN" "$@"
}

verify_service_active() {
  local service="$1"
  run_systemctl is-active --quiet "$service"
}

print_caddy_command() {
  print_command "$CADDY_BINARY" "$@"
}

run_caddy() {
  run_command "$CADDY_BINARY" "$@"
}

normalize_caddy_admin_address() {
  case "$1" in
    127.0.0.1:2019|http://127.0.0.1:2019|https://127.0.0.1:2019)
      CADDY_RELOAD_ADDRESS="127.0.0.1:2019"
      ;;
    *)
      printf 'invalid Caddy admin address: %s\n' "$1" >&2
      return 2
      ;;
  esac
}

preflight() {
  if [[ "$DRY_RUN" -eq 0 && "$(id -u)" != 0 ]]; then
    printf '%s --apply must run as root\n' "$ACTION" >&2
    exit 1
  fi

  if ! valid_unit_name "$OLD_PROJECTS_SERVICE" || ! valid_unit_name "$NEW_DAEMON_SERVICE"; then
    printf 'service names must be simple systemd unit names\n' >&2
    exit 2
  fi

  if [[ "$SYSTEMCTL_BIN" == */* ]]; then
    [[ -x "$SYSTEMCTL_BIN" ]] || { printf 'systemctl is not executable: %s\n' "$SYSTEMCTL_BIN" >&2; exit 1; }
  else
    command -v "$SYSTEMCTL_BIN" >/dev/null || { printf 'missing systemctl: %s\n' "$SYSTEMCTL_BIN" >&2; exit 1; }
  fi
  # Check every unit in the system manager before stopping anything. `cat` is
  # read-only and confirms that both daemon units are installed.
  "$SYSTEMCTL_BIN" cat "$OLD_PROJECTS_SERVICE" >/dev/null
  "$SYSTEMCTL_BIN" cat "$NEW_DAEMON_SERVICE" >/dev/null

  if [[ "$ACTION" == "rollback" ]]; then
    [[ -n "$CADDY_BACKUP" ]] || { printf '%s requires --caddy-backup\n' "$ACTION" >&2; exit 2; }
    if [[ -d "$CADDY_BACKUP" ]]; then
      CADDY_BACKUP_CONFIG="$CADDY_BACKUP/caddy-admin-config.json"
    else
      CADDY_BACKUP_CONFIG="$CADDY_BACKUP"
    fi

    [[ -x "$CADDY_BINARY" ]] || { printf 'Caddy binary is not executable: %s\n' "$CADDY_BINARY" >&2; exit 1; }
    [[ -f "$CADDY_BACKUP_CONFIG" && ! -L "$CADDY_BACKUP_CONFIG" && -r "$CADDY_BACKUP_CONFIG" ]] || {
      printf 'saved Caddy JSON is missing, symlinked, or unreadable: %s\n' "$CADDY_BACKUP_CONFIG" >&2
      exit 1
    }
    [[ -f "$CADDY_CONFIG" && ! -L "$CADDY_CONFIG" ]] || {
      printf 'live Caddy config is missing or symlinked: %s\n' "$CADDY_CONFIG" >&2
      exit 1
    }
    caddy_config_directory="$(dirname -- "$CADDY_CONFIG")"
    [[ -d "$caddy_config_directory" && -w "$caddy_config_directory" && -x "$caddy_config_directory" ]] || {
      printf 'live Caddy config directory is not writable/traversable: %s\n' "$caddy_config_directory" >&2
      exit 1
    }
    [[ -w "$CADDY_CONFIG" ]] || {
      printf 'live Caddy config is not writable: %s\n' "$CADDY_CONFIG" >&2
      exit 1
    }
    command -v cp >/dev/null || { printf 'missing cp\n' >&2; exit 1; }
    command -v mv >/dev/null || { printf 'missing mv\n' >&2; exit 1; }
    command -v mktemp >/dev/null || { printf 'missing mktemp\n' >&2; exit 1; }
    # This is deliberately before the first service mutation. Caddy validate
    # loads the JSON and modules but does not contact the admin API or start a
    # listener.
    if [[ "$DRY_RUN" -eq 1 ]]; then
      print_caddy_command validate --config "$CADDY_BACKUP_CONFIG" --adapter ""
      "$CADDY_BINARY" validate --config "$CADDY_BACKUP_CONFIG" --adapter ""
    else
      run_caddy validate --config "$CADDY_BACKUP_CONFIG" --adapter ""
    fi
  fi
}

cutover_plan() {
  printf 'action: cutover\n'
  printf 'mode: dry-run\n'
  printf 'preflight: inspected both daemon units with read-only systemd queries\n'
  print_systemctl_command stop "$OLD_PROJECTS_SERVICE"
  print_systemctl_command disable "$OLD_PROJECTS_SERVICE"
  print_systemctl_command daemon-reload
  print_systemctl_command enable "$NEW_DAEMON_SERVICE"
  print_systemctl_command start "$NEW_DAEMON_SERVICE"
  printf 'no services changed\n'
}

rollback_plan() {
  printf 'action: rollback\n'
  printf 'mode: dry-run\n'
  printf 'preflight: inspected both daemon units and validated saved Caddy JSON offline\n'
  print_systemctl_command stop "$NEW_DAEMON_SERVICE"
  print_systemctl_command disable "$NEW_DAEMON_SERVICE"
  printf 'would reload saved Caddy JSON through the running system caddy.service: %s\n' "$CADDY_BACKUP_CONFIG"
  print_caddy_command reload --config "$CADDY_BACKUP_CONFIG" --adapter "" --address "$CADDY_RELOAD_ADDRESS"
  printf 'would persist restored Caddy JSON: %s -> %s\n' "$CADDY_BACKUP_CONFIG" "$CADDY_CONFIG"
  print_systemctl_command daemon-reload
  print_systemctl_command enable "$OLD_PROJECTS_SERVICE"
  print_systemctl_command start "$OLD_PROJECTS_SERVICE"
  printf 'no services changed\n'
}

prepare_action() {
  local mode_argument="--dry-run"
  local prepare_mode_seen=0
  local -a prepare_arguments=()

  while (($# > 0)); do
    case "$1" in
      --dry-run)
        if [[ "$prepare_mode_seen" -eq 1 ]]; then
          printf '%s and --apply are mutually exclusive\n' "$1" >&2
          exit 2
        fi
        prepare_mode_seen=1
        mode_argument="--dry-run"
        ;;
      --apply)
        if [[ "$prepare_mode_seen" -eq 1 ]]; then
          printf '%s and --dry-run are mutually exclusive\n' "$1" >&2
          exit 2
        fi
        prepare_mode_seen=1
        mode_argument="--apply"
        ;;
      *)
        prepare_arguments+=("$1")
        ;;
    esac
    shift
  done

  exec bash "$SCRIPT_DIR/prepare-leo.bash" "$mode_argument" "${prepare_arguments[@]}"
}

parse_service_options() {
  while (($# > 0)); do
    case "$1" in
      --dry-run|--apply)
        mode_option "$1"
        ;;
      --old-projects-service|--legacy-daemon-service)
        OLD_PROJECTS_SERVICE="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --new-daemon-service|--project-registryd-service)
        NEW_DAEMON_SERVICE="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --systemctl-bin)
        SYSTEMCTL_BIN="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --caddy-binary|--caddy-bin)
        CADDY_BINARY="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --caddy-config|--caddy-config-destination)
        CADDY_CONFIG="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --caddy-backup|--caddy-backup-config|--legacy-caddy-config)
        CADDY_BACKUP="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --caddy-admin-url|--caddy-admin-address)
        CADDY_ADMIN_URL="$(argument_value "$1" "${2:-}")"
        shift
        ;;
      --help|-h)
        usage
        exit 0
        ;;
      *)
        printf 'unknown argument for %s: %s\n' "$ACTION" "$1" >&2
        usage >&2
        exit 2
        ;;
    esac
    shift
  done
}

ACTION="${1:-}"
if [[ -z "$ACTION" ]]; then
  usage >&2
  exit 2
fi
shift

case "$ACTION" in
  prepare)
    prepare_action "$@"
    ;;
  cutover|rollback)
    parse_service_options "$@"
    if [[ "$ACTION" == "rollback" ]]; then
      normalize_caddy_admin_address "$CADDY_ADMIN_URL"
    fi
    preflight
    if [[ "$DRY_RUN" -eq 1 ]]; then
      if [[ "$ACTION" == "cutover" ]]; then
        cutover_plan
      else
        rollback_plan
      fi
      exit 0
    fi

    if [[ "$ACTION" == "cutover" ]]; then
      run_systemctl stop "$OLD_PROJECTS_SERVICE"
      run_systemctl disable "$OLD_PROJECTS_SERVICE"
      run_systemctl daemon-reload
      run_systemctl enable "$NEW_DAEMON_SERVICE"
      run_systemctl start "$NEW_DAEMON_SERVICE"
      verify_service_active "$NEW_DAEMON_SERVICE"
      printf 'cutover completed\n'
    else
      run_systemctl stop "$NEW_DAEMON_SERVICE"
      run_systemctl disable "$NEW_DAEMON_SERVICE"

      # The public Caddy process is intentionally never passed to systemctl.
      # Stop the replacement daemon first, restore the legacy config through
      # the running Caddy admin API, and only then resume the old daemon.
      run_caddy reload --config "$CADDY_BACKUP_CONFIG" --adapter "" --address "$CADDY_RELOAD_ADDRESS"
      rollback_config_temp="$(mktemp "$(dirname "$CADDY_CONFIG")/.caddy-rollback.XXXXXX")"
      cleanup_rollback_config() {
        if [[ -n "${rollback_config_temp:-}" && -e "$rollback_config_temp" ]]; then
          rm -f -- "$rollback_config_temp"
        fi
      }
      trap cleanup_rollback_config EXIT
      cp --preserve=mode,ownership -- "$CADDY_BACKUP_CONFIG" "$rollback_config_temp"
      mv -f -- "$rollback_config_temp" "$CADDY_CONFIG"
      rollback_config_temp=""
      run_systemctl daemon-reload
      run_systemctl enable "$OLD_PROJECTS_SERVICE"
      run_systemctl start "$OLD_PROJECTS_SERVICE"
      verify_service_active "$OLD_PROJECTS_SERVICE"
      printf 'rollback completed\n'
    fi
    ;;
  --help|-h)
    usage
    ;;
  *)
    printf 'unknown action: %s\n' "$ACTION" >&2
    usage >&2
    exit 2
    ;;
esac
