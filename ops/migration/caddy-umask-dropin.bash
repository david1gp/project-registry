#!/usr/bin/env bash

# The Caddy unit is owned by the host.  Only this reviewed, narrowly scoped
# drop-in is staged or installed by the task-8 migration mechanics.

CADDY_UMASK_DROPIN_NAME="10-project-registry-umask.conf"

caddy_umask_dropin_fail() {
  printf '%s\n' "$1" >&2
  return 1
}

caddy_umask_dropin_validate() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || {
    caddy_umask_dropin_fail "missing, symlinked, or unreadable Caddy UMask drop-in: $path"
    return 1
  }

  local section="" line umask_count=0
  while IFS= read -r line || [[ -n "$line" ]]; do
    line="${line%$'\r'}"
    [[ -z "$line" || "$line" == \#* || "$line" == \;* ]] && continue
    if [[ "$line" == "[Service]" ]]; then
      [[ -z "$section" ]] || {
        caddy_umask_dropin_fail "Caddy UMask drop-in has duplicate or unsupported sections: $path"
        return 1
      }
      section=service
      continue
    fi
    [[ "$section" == service ]] || {
      caddy_umask_dropin_fail "Caddy UMask drop-in has content outside [Service]: $path"
      return 1
    }
    if [[ "$line" == UMask=* ]]; then
      [[ "$line" == "UMask=0077" ]] || {
        caddy_umask_dropin_fail "Caddy UMask drop-in must set UMask=0077: $path"
        return 1
      }
      umask_count=$((umask_count + 1))
      continue
    fi
    caddy_umask_dropin_fail "Caddy UMask drop-in contains an unreviewed directive: $path"
    return 1
  done < "$path"

  [[ "$section" == service && "$umask_count" -eq 1 ]] || {
    caddy_umask_dropin_fail "Caddy UMask drop-in must contain exactly one UMask=0077: $path"
    return 1
  }
}

caddy_umask_dropin_install() {
  local source="$1"
  local target="$2"
  local install_command="${3:-${INSTALL_BIN:-install}}"
  caddy_umask_dropin_validate "$source" || return 1
  if [[ -L "$target" ]]; then
    caddy_umask_dropin_fail "refusing to replace symbolic-link Caddy UMask drop-in: $target"
    return 1
  fi
  "$install_command" -o root -g root -m 0644 -- "$source" "$target" || {
    caddy_umask_dropin_fail "unable to install Caddy UMask drop-in: $target"
    return 1
  }
  caddy_umask_dropin_validate "$target" || return 1
  local mode
  mode="$(stat -c '%a' -- "$target")" || return 1
  [[ "$mode" == 644 || "$mode" == 0644 ]] || {
    caddy_umask_dropin_fail "Caddy UMask drop-in must be mode 0644: $target"
    return 1
  }
}

caddy_umask_dropin_verify_unit() {
  local unit="$1"
  local analyzer="${2:-${SYSTEMD_ANALYZE_BIN:-systemd-analyze}}"
  [[ -f "$unit" && ! -L "$unit" ]] || {
    caddy_umask_dropin_fail "missing or symlinked Caddy unit for drop-in verification: $unit"
    return 1
  }
  caddy_umask_dropin_validate "$(dirname -- "$unit")/caddy.service.d/$CADDY_UMASK_DROPIN_NAME" || return 1
  "$analyzer" verify "$unit"
}
