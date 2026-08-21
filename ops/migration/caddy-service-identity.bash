#!/usr/bin/env bash

# Read-only identity resolution for the authoritative system caddy.service.
# CADDY_SERVICE_IDENTITY_FILE and CADDY_SERVICE_IDENTITY_OUTPUT are test/offline
# injection points; neither is used by production unless explicitly supplied.

caddy_service_identity_fail() {
  printf '%s\n' "$1" >&2
  exit 1
}

caddy_service_identity_value_validate() {
  local kind="$1"
  local value="$2"
  local numeric

  [[ -n "$value" ]] || caddy_service_identity_fail "authoritative caddy.service has no concrete $kind identity"
  [[ "$value" != root && "$value" != 0 ]] || caddy_service_identity_fail "authoritative caddy.service $kind identity must not be root"
  [[ "$value" =~ ^[0-9]+$ || "$value" =~ ^[A-Za-z_][A-Za-z0-9_.@-]*\$?$ ]] || \
    caddy_service_identity_fail "authoritative caddy.service $kind identity is not concrete: $value"

  if [[ "$kind" == user ]]; then
    numeric="$(id -u -- "$value" 2>/dev/null)" || caddy_service_identity_fail "unable to resolve caddy.service user: $value"
  else
    local group_record
    group_record="$(getent group -- "$value" 2>/dev/null)" || caddy_service_identity_fail "unable to resolve caddy.service group: $value"
    numeric="${group_record%%:*}"
    numeric="${group_record#*:}"
    numeric="${numeric#*:}"
    numeric="${numeric%%:*}"
  fi
  [[ "$numeric" =~ ^[0-9]+$ && "$numeric" != 0 ]] || \
    caddy_service_identity_fail "authoritative caddy.service $kind identity must resolve to a non-root ID: $value"
}

caddy_service_identity_load() {
  local output line user="" group="" value
  if [[ -n "${CADDY_SERVICE_IDENTITY_FILE:-}" ]]; then
    [[ -r "$CADDY_SERVICE_IDENTITY_FILE" ]] || \
      caddy_service_identity_fail "missing or unreadable Caddy service identity fixture: $CADDY_SERVICE_IDENTITY_FILE"
    output="$(<"$CADDY_SERVICE_IDENTITY_FILE")"
  elif [[ -n "${CADDY_SERVICE_IDENTITY_OUTPUT:-}" ]]; then
    output="$CADDY_SERVICE_IDENTITY_OUTPUT"
  else
    output="$("${CADDY_SYSTEMCTL:-systemctl}" show "${CADDY_SERVICE_NAME:-caddy.service}" --property=User --property=Group 2>/dev/null)" || \
      caddy_service_identity_fail "unable to obtain effective User and Group for caddy.service"
  fi

  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    case "$line" in
      User=*)
        [[ -z "$user" ]] || caddy_service_identity_fail "authoritative caddy.service has duplicate User properties"
        user="${line#User=}"
        ;;
      Group=*)
        [[ -z "$group" ]] || caddy_service_identity_fail "authoritative caddy.service has duplicate Group properties"
        group="${line#Group=}"
        ;;
    esac
  done <<< "$output"

  caddy_service_identity_value_validate user "$user"
  caddy_service_identity_value_validate group "$group"
  if [[ -n "${CADDY_USER:-}" && "$CADDY_USER" != "$user" ]]; then
    caddy_service_identity_fail "configured CADDY_USER=$CADDY_USER mismatches caddy.service User=$user"
  fi
  if [[ -n "${CADDY_GROUP:-}" && "$CADDY_GROUP" != "$group" ]]; then
    caddy_service_identity_fail "configured CADDY_GROUP=$CADDY_GROUP mismatches caddy.service Group=$group"
  fi
  CADDY_USER="$user"
  CADDY_GROUP="$group"
  export CADDY_USER CADDY_GROUP
}
