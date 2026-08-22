#!/usr/bin/env bash

# The Caddy file writer owns access.jsonl and its rotated archives. The root
# daemon reads those files and owns the retention metadata. Provision only the
# three directories needed by Caddy and leave all existing log entries alone.
caddy_access_log_root_prepare() {
  local root="$1"
  local caddy_user="$2"
  local caddy_group="$3"
  local install_command="${INSTALL_BIN:-install}"
  local directory

  [[ -n "$root" ]] || return 0
  for directory in "$root" "$root/projects" "$root/quarantine"; do
    if [[ -L "$directory" ]]; then
      printf 'Caddy access-log directory is a symbolic link: %s\n' "$directory" >&2
      return 1
    fi
    if [[ -e "$directory" && ! -d "$directory" ]]; then
      printf 'Caddy access-log path is not a directory: %s\n' "$directory" >&2
      return 1
    fi
    "$install_command" -d -o "$caddy_user" -g "$caddy_group" -m 0700 -- "$directory" || {
      printf 'unable to provision Caddy access-log directory: %s\n' "$directory" >&2
      return 1
    }
  done
}
