#!/usr/bin/env bash
set -euo pipefail

# Explicit, read-only-after-requests staging check for the deployed Caddy and
# project-registry surfaces. This intentionally has no production defaults.
# --run requires a root-owned deployment attestation binding all target
# inputs. Caddy's active identity is read from systemd, never caller-supplied.
umask 077
shopt -s nullglob

readonly script_name="caddy-project-access-logs-check.bash"
readonly caddy_roll_bytes=$((25 * 1024 * 1024))
readonly caddy_max_archives=8
readonly maximum_project_bytes=$((caddy_roll_bytes * (caddy_max_archives + 1) + 1024 * 1024))
readonly maximum_page_bytes=$((8 * 1024 * 1024))
readonly maximum_access_log_records=1000000
readonly maximum_access_log_line_bytes=$((128 * 1024))
readonly maximum_access_log_scanned_bytes=$((64 * 1024 * 1024))
readonly maximum_access_log_decompressed_bytes=$((64 * 1024 * 1024))
readonly access_log_api_page_limit=1000
readonly maximum_rotation_request_count=100000
# The aggregate includes the initial, pre-rotation, and post-rotation markers.
readonly maximum_rotation_api_records=$((maximum_rotation_request_count + 3))
readonly maximum_rotation_api_pages=$(((maximum_rotation_api_records + access_log_api_page_limit - 1) / access_log_api_page_limit))
readonly rotation_batch_size=100
readonly rotation_observation_attempts=30
readonly bounded_stream_capture_overflow_status=2

help() {
  cat <<'USAGE'
Usage:
  caddy-project-access-logs-check.bash --validate
  caddy-project-access-logs-check.bash --run [options]

--validate performs only local prerequisite validation and never contacts a
target, reads a supplied credential file, or changes a staging deployment.
--run is mandatory for the end-to-end check. All target and credential inputs
below are mandatory; there are no host, socket, log-root, or secret defaults.

Required --run options:
  --api-url URL                 project-registryd HTTP base URL
  --caddy-url URL               disposable Caddy base URL
  --api-headers-a FILE          HTTP session headers for owner A (contains Cookie)
  --api-headers-b FILE          HTTP session headers for owner B (contains Cookie)
  --unix-socket-a PATH          owner A project-registryd Unix socket
  --unix-socket-b PATH          owner B project-registryd Unix socket
  --cli PATH                    deployed project-registry CLI executable
  --log-root PATH               Caddy access-log root outside Git storage
  --staging-attestation FILE    pre-created root:root 0600 deployment attestation
  --owner-a USER                owner bound to socket A and project A
  --owner-b USER                owner bound to socket B and project B
  --project-a NAME              disposable project owned by owner A
  --project-b NAME              disposable project owned by owner B
  --host-a HOST                 distinct Caddy host for project A
  --host-b HOST                 distinct Caddy host for project B
  --request-path PATH           safe GET path served by both disposable projects
  --rotation-count N            maximum GET requests allowed to trigger one roll

Optional --run options:
  --insecure                    allow an explicitly supplied staging TLS certificate mismatch
  --help                        show this help

The check sends only GET requests, keeps response bodies in mode-0600 temporary
files, never prints request or response data, and requires a fresh A log
directory without existing archives so the rotation assertion is unambiguous.

The deployment must create --staging-attestation before invoking --run. Its
exact contents are four newline-terminated lines (no extra fields or bytes):
  version=1
  purpose=caddy-project-access-logs-staging
  deployment_id=<32 lowercase hexadecimal characters>
  target_sha256=<64 lowercase hexadecimal characters>
The target digest is the SHA-256 of the NUL-separated --run binding described
by target_binding in this script; the attestation path, deployment ID,
rotation count, and TLS mode are included. The check never creates or updates
the attestation.
USAGE
}

fail() {
  printf '%s\n' "$script_name failed: $1" >&2
  exit 1
}

argument_value() {
  local option="$1"
  local value="${2:-}"
  [[ -n "$value" && "$value" != --* ]] || {
    printf '%s requires a value\n' "$option" >&2
    exit 2
  }
  printf '%s' "$value"
}

command_require() {
  command -v "$1" >/dev/null 2>&1 || fail "required local command is unavailable"
}

url_validate() {
  local value="$1"
  [[ "$value" =~ ^https?://[^[:space:]\?\#\"\\]+$ ]] || fail "URL input is invalid"
  [[ "$value" != *"@"* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "URL input is invalid"
}

absolute_path_validate() {
  local value="$1"
  [[ "$value" == /* && "$value" != "/" && "$value" != */ && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || {
    fail "path input is invalid"
  }
}

no_symlink_ancestor_validate() {
  local path="$1"
  local label="$2"
  local remainder="${path#/}" component current="/"
  while [[ -n "$remainder" ]]; do
    if [[ "$remainder" == */* ]]; then
      component="${remainder%%/*}"
      remainder="${remainder#*/}"
    else
      component="$remainder"
      remainder=""
    fi
    [[ -n "$component" && "$component" != . && "$component" != .. ]] || fail "$label path is not canonical"
    current="${current%/}/$component"
    [[ ! -L "$current" ]] || fail "$label path contains a symbolic link"
  done
}

owner_validate() {
  [[ "$1" =~ ^[A-Za-z_][A-Za-z0-9_.-]*\$?$ ]] || fail "owner input is invalid"
}

project_validate() {
  [[ "$1" =~ ^[a-z0-9][a-z0-9-]*$ ]] || fail "project input is invalid"
}

host_validate() {
  [[ "$1" =~ ^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$ ]] || fail "host input is invalid"
}

request_path_validate() {
  local value="$1"
  [[ "$value" == /* ]] || fail "request path input is invalid"
  [[ "$value" != *"?"* && "$value" != *"#"* && "$value" != *'"'* && "$value" != *"\\"* ]] || {
    fail "request path input is invalid"
  }
  [[ "$value" != *[[:space:]]* && "$value" != *$'\n'* && "$value" != *$'\r'* ]] || fail "request path input is invalid"
}

secret_file_validate() {
  local path="$1"
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || fail "HTTP credential header file is unavailable"
  local mode
  mode="$(stat -c '%a' -- "$path")" || fail "HTTP credential header file cannot be inspected"
  [[ "$mode" =~ ^[0-7]+$ ]] || fail "HTTP credential header file mode is invalid"
  (( (10#$mode & 077) == 0 )) || fail "HTTP credential header file is too broadly readable"
  awk '
    BEGIN { found = 0 }
    /^[[:space:]]*[Cc][Oo][Oo][Kk][Ii][Ee]:/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$path" >/dev/null 2>&1 || fail "HTTP credential header file must contain a Cookie header"
}

secret_comparison_file_path=""

secret_comparison_file_create() {
  local value="$1"
  local path bytes mode
  path="$(mktemp "$work/secret-comparison.XXXXXX")" || fail "secret comparison file cannot be created"
  printf '%s' "$value" >"$path" || fail "secret comparison file cannot be written"
  bytes="$(wc -c <"$path")" || fail "secret comparison file cannot be measured"
  [[ "$bytes" =~ ^[0-9]+$ && "$bytes" -le "$maximum_access_log_line_bytes" ]] || {
    fail "secret comparison value is too large"
  }
  mode="$(stat -c '%a' -- "$path")" || fail "secret comparison file cannot be inspected"
  [[ -f "$path" && ! -L "$path" && "$mode" == 600 ]] || {
    fail "secret comparison file is not protected"
  }
  secret_comparison_file_path="$path"
}

socket_validate() {
  local path="$1"
  [[ -S "$path" && ! -L "$path" ]] || fail "Unix socket input is unavailable"
}

executable_validate() {
  local path="$1"
  local parent uid mode

  no_symlink_ancestor_validate "$path" "CLI executable"
  [[ -f "$path" && ! -L "$path" && -x "$path" ]] || fail "CLI executable input is unavailable"
  IFS=: read -r uid mode < <(stat -c '%u:%a' -- "$path") || fail "CLI executable cannot be inspected"
  [[ "$uid" == 0 && "$mode" =~ ^[0-7]+$ && $((8#$mode & 022)) == 0 ]] || {
    fail "CLI executable must be root-owned and not group/other-writable"
  }

  parent="${path%/*}"
  [[ -n "$parent" ]] || parent="/"
  while :; do
    [[ -d "$parent" && ! -L "$parent" ]] || fail "CLI executable parent directory is unavailable or symbolic"
    IFS=: read -r uid mode < <(stat -c '%u:%a' -- "$parent") || {
      fail "CLI executable parent directory cannot be inspected"
    }
    [[ "$uid" == 0 && "$mode" =~ ^[0-7]+$ && $((8#$mode & 022)) == 0 ]] || {
      fail "CLI executable parent directory must be root-owned and not group/other-writable"
    }
    [[ "$parent" == "/" ]] && break
    parent="${parent%/*}"
    [[ -n "$parent" ]] || parent="/"
  done
}

identity_resolve() {
  local output line user="" group="" load_state="" active_state=""
  command_require systemctl
  output="$(systemctl show caddy.service --property=LoadState --property=ActiveState --property=User --property=Group --no-pager 2>/dev/null)" || \
    fail "effective caddy.service identity cannot be obtained from systemd"

  while IFS= read -r line || [[ -n "$line" ]]; do
    case "$line" in
      LoadState=*)
        [[ -z "$load_state" ]] || fail "effective caddy.service state is ambiguous"
        load_state="${line#LoadState=}"
        ;;
      ActiveState=*)
        [[ -z "$active_state" ]] || fail "effective caddy.service state is ambiguous"
        active_state="${line#ActiveState=}"
        ;;
      User=*)
        [[ -z "$user" ]] || fail "effective caddy.service identity is ambiguous"
        user="${line#User=}"
        ;;
      Group=*)
        [[ -z "$group" ]] || fail "effective caddy.service identity is ambiguous"
        group="${line#Group=}"
        ;;
    esac
  done <<< "$output"

  [[ "$load_state" == loaded && "$active_state" == active ]] || \
    fail "effective caddy.service is not loaded and active"
  [[ "$user" =~ ^[A-Za-z_][A-Za-z0-9_.@-]*\$?$ || "$user" =~ ^[1-9][0-9]*$ ]] || \
    fail "effective caddy.service User is missing or invalid"
  [[ "$group" =~ ^[A-Za-z_][A-Za-z0-9_.@-]*\$?$ || "$group" =~ ^[1-9][0-9]*$ ]] || \
    fail "effective caddy.service Group is missing or invalid"
  [[ "$user" != root && "$user" != 0 && "$group" != root && "$group" != 0 ]] || \
    fail "effective caddy.service identity must be non-root"

  if [[ "$user" =~ ^[1-9][0-9]*$ ]]; then
    caddy_uid="$user"
  else
    caddy_uid="$(id -u -- "$user" 2>/dev/null)" || fail "effective caddy.service User cannot be resolved"
  fi
  if [[ "$group" =~ ^[1-9][0-9]*$ ]]; then
    caddy_gid="$group"
  else
    caddy_gid="$(getent group -- "$group" | awk -F: 'NR == 1 { print $3 }')" || \
      fail "effective caddy.service Group cannot be resolved"
  fi
  [[ "$caddy_uid" =~ ^[1-9][0-9]*$ && "$caddy_gid" =~ ^[1-9][0-9]*$ ]] || \
    fail "effective caddy.service identity must be non-root"
}

target_binding() {
  printf '%s\0' \
    "$api_url" "$caddy_url" "$api_headers_a" "$api_headers_b" \
    "$unix_socket_a" "$unix_socket_b" "$cli" "$log_root" \
    "$staging_attestation" "$deployment_id" "$owner_a" "$owner_b" \
    "$project_a" "$project_b" "$host_a" "$host_b" "$request_path" \
    "$rotation_count" "$insecure" |
    sha256sum | awk '{ print $1 }'
}

staging_attestation_validate() {
  local path="$staging_attestation"
  local uid gid mode bytes line1 line2 line3 line4 extra deployment_id_value digest
  no_symlink_ancestor_validate "$path" "staging deployment attestation"
  [[ -f "$path" && ! -L "$path" && -r "$path" ]] || fail "staging deployment attestation is unavailable"
  IFS=: read -r uid gid mode < <(stat -c '%u:%g:%a' -- "$path") || fail "staging deployment attestation cannot be inspected"
  [[ "$uid" == 0 && "$gid" == 0 && "$mode" == 600 ]] || \
    fail "staging deployment attestation must be root-owned and mode 0600"
  bytes="$(wc -c <"$path")" || fail "staging deployment attestation cannot be measured"
  [[ "$bytes" =~ ^[0-9]+$ && "$bytes" -le 512 ]] || fail "staging deployment attestation is too large"

  exec 3<"$path" || fail "staging deployment attestation cannot be read"
  IFS= read -r line1 <&3 || { exec 3<&-; fail "staging deployment attestation is not canonical"; }
  IFS= read -r line2 <&3 || { exec 3<&-; fail "staging deployment attestation is not canonical"; }
  IFS= read -r line3 <&3 || { exec 3<&-; fail "staging deployment attestation is not canonical"; }
  IFS= read -r line4 <&3 || { exec 3<&-; fail "staging deployment attestation is not canonical"; }
  if IFS= read -r extra <&3 || [[ -n "$extra" ]]; then
    case "$extra" in
      *)
        exec 3<&-
        fail "staging deployment attestation contains an unexpected field"
        ;;
    esac
  fi
  exec 3<&-

  [[ "$line1" == version=1 && "$line2" == purpose=caddy-project-access-logs-staging ]] || \
    fail "staging deployment attestation is not for this check"
  [[ "$line3" == deployment_id=* && "$line4" == target_sha256=* ]] || \
    fail "staging deployment attestation is not canonical"
  deployment_id_value="${line3#deployment_id=}"
  digest="${line4#target_sha256=}"
  [[ "$deployment_id_value" =~ ^[0-9a-f]{32}$ ]] || fail "staging deployment attestation deployment ID is invalid"
  deployment_id="$deployment_id_value"
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || fail "staging deployment attestation digest is invalid"
  [[ "$digest" == "$(target_binding)" ]] || fail "staging deployment attestation does not match the target"
}

entry_mode_owner_assert() {
  local path="$1"
  local expected_mode="$2"
  local uid gid mode
  [[ ! -L "$path" && -e "$path" ]] || fail "access-log path is missing or symbolic"
  IFS=: read -r uid gid mode < <(stat -c '%u:%g:%a' -- "$path") || fail "access-log path cannot be inspected"
  [[ "$uid" == "$caddy_uid" && "$gid" == "$caddy_gid" && "$mode" == "$expected_mode" ]] || {
    fail "access-log ownership or permissions are incorrect"
  }
}

root_validate() {
  no_symlink_ancestor_validate "$log_root" "Caddy access-log root"
  [[ -d "$log_root" && ! -L "$log_root" ]] || fail "Caddy access-log root is unavailable"
  entry_mode_owner_assert "$log_root" 700
  for directory in "$log_root/projects" "$log_root/quarantine"; do
    [[ -d "$directory" && ! -L "$directory" ]] || fail "Caddy access-log hierarchy is incomplete"
    entry_mode_owner_assert "$directory" 700
  done
}

project_id() {
  local digest
  digest="$(printf '["%s","%s"]' "$1" "$2" | sha256sum)" || fail "project access-log identity cannot be derived"
  printf '%s' "${digest%% *}"
}

project_directory() {
  printf '%s/projects/%s' "$log_root" "$(project_id "$1" "$2")"
}

archive_name_is_valid() {
  [[ "$1" =~ ^access-[A-Za-z0-9_.-]+\.jsonl(\.gz)?$ ]]
}

retention_metadata_validate() {
  local path="$1"
  local uid gid mode
  [[ ! -L "$path" && -f "$path" ]] || fail "retention metadata is not a regular file"
  IFS=: read -r uid gid mode < <(stat -c '%u:%g:%a' -- "$path") || fail "retention metadata cannot be inspected"
  [[ "$uid" == 0 && "$gid" == 0 && "$mode" == 600 ]] || \
    fail "retention metadata must be root-owned and mode 0600"
  jq -e -s '
    def timestamp:
      type == "number" and floor == . and . >= 0 and . <= 9007199254740991;
    length == 1 and
    (.[0] | type == "object") and
    (.[0] | .version == 1) and
    (.[0] |
      ((.state == "active" and (keys | sort == ["state", "version"])) or
       (.state == "inactive" and
        (keys | sort == ["inactiveAt", "state", "version"]) and
        (.inactiveAt | timestamp)) or
       (.state == "quarantined" and
        (keys | sort == ["inactiveAt", "quarantinedAt", "state", "version"]) and
        (.inactiveAt | timestamp) and
        (.quarantinedAt | timestamp) and
        (.quarantinedAt >= .inactiveAt))))
  ' "$path" >/dev/null 2>&1 || fail "retention metadata JSON is invalid"
}

project_entries_validate() {
  local directory="$1"
  local allow_empty="$2"
  local entry name archive_base active=0 archive_count=0 archive_entry_count=0 metadata_count=0
  local -A archive_plain_seen=() archive_gzip_seen=() archive_bases=()
  [[ ! -L "$directory" && -d "$directory" ]] || fail "project access-log directory is unavailable"
  entry_mode_owner_assert "$directory" 700

  for entry in "$directory"/* "$directory"/.[!.]* "$directory"/..?*; do
    [[ -e "$entry" || -L "$entry" ]] || continue
    [[ ! -L "$entry" && -f "$entry" ]] || fail "project access-log entry is not a regular file"
    name="${entry##*/}"
    if [[ "$name" == access.jsonl ]]; then
      active=$((active + 1))
      entry_mode_owner_assert "$entry" 600
    elif [[ "$name" == .project-registry-retention.json ]]; then
      metadata_count=$((metadata_count + 1))
      retention_metadata_validate "$entry"
    elif archive_name_is_valid "$name"; then
      archive_entry_count=$((archive_entry_count + 1))
      ((archive_entry_count <= caddy_max_archives * 2)) || fail "Caddy access-log archive entry count is unbounded"
      if [[ "$name" == *.gz ]]; then
        archive_base="${name%.gz}"
        [[ -z "${archive_gzip_seen[$archive_base]+seen}" ]] || fail "project has duplicate gzip access-log archives"
        archive_gzip_seen["$archive_base"]=1
      else
        archive_base="$name"
        [[ -z "${archive_plain_seen[$archive_base]+seen}" ]] || fail "project has duplicate plain access-log archives"
        archive_plain_seen["$archive_base"]=1
      fi
      archive_bases["$archive_base"]=1
      entry_mode_owner_assert "$entry" 600
    else
      fail "unexpected project access-log entry"
    fi
  done

  archive_count="${#archive_bases[@]}"
  ((metadata_count <= 1)) || fail "project has multiple retention metadata files"
  ((archive_count <= caddy_max_archives)) || fail "Caddy access-log archive count is unbounded"
  if [[ "$allow_empty" == yes ]]; then
    ((active <= 1)) || fail "project has multiple active access-log files"
  else
    ((active == 1)) || fail "active project access-log file is missing"
  fi
  printf '%s' "$archive_count"
}

project_fresh_validate() {
  local directory="$1"
  [[ ! -L "$directory" ]] || fail "staging project access-log directory is symbolic"
  [[ ! -e "$directory" ]] && return 0
  [[ -d "$directory" ]] || fail "staging project access-log path is not a directory"
  local archive_count
  archive_count="$(project_entries_validate "$directory" yes)"
  ((archive_count == 0)) || fail "staging project already has rotated archives"
  if [[ -f "$directory/access.jsonl" ]]; then
    [[ "$(stat -c '%s' -- "$directory/access.jsonl")" == 0 ]] || fail "staging project has existing access-log data"
  fi
}

archive_count_read() {
  local directory="$1"
  [[ -d "$directory" ]] || {
    printf '0'
    return
  }
  project_entries_validate "$directory" yes
}

page_bytes_assert() {
  local path="$1"
  local bytes
  bytes="$(wc -c < "$path")" || fail "bounded response size could not be measured"
  ((bytes <= maximum_page_bytes)) || fail "access-log response exceeded the bounded page size"
}

bounded_response_capture() {
  local output="$1"
  local bytes extra_bytes

  : >"$output" || return 1
  dd iflag=fullblock bs="$maximum_page_bytes" count=1 status=none of="$output" || return 1
  bytes="$(wc -c <"$output")" || return 1
  if ((bytes == maximum_page_bytes)); then
    extra_bytes="$(dd bs=1 count=1 status=none | wc -c)" || return 1
    if ((extra_bytes != 0)); then
      return 1
    fi
  fi
}

bounded_stream_capture() {
  local output="$1"
  python3 -c '
import sys

output_path = sys.argv[1]
capture_limit = int(sys.argv[2])
captured = 0
overflowed = False

try:
    with open(output_path, "wb") as output:
        while True:
            chunk = sys.stdin.buffer.read(64 * 1024)
            if not chunk:
                break
            if captured < capture_limit:
                kept = chunk[: capture_limit - captured]
                output.write(kept)
                captured += len(kept)
                if len(kept) != len(chunk):
                    overflowed = True
            else:
                overflowed = True
except (OSError, ValueError):
    raise SystemExit(1)

if overflowed:
    raise SystemExit(2)
' "$output" "$maximum_page_bytes" 2>/dev/null
}

page_shape_assert() {
  local path="$1"
  jq -e '
    .success == true and
    (.data | type == "object") and
    (.data.records | type == "array") and
    (.data.records | length <= 1000) and
    (.data.next == null or (.data.next | type == "string" and length > 0 and length <= 4096)) and
    (.data.partial == false) and
    (.data.malformedLines == 0)
  ' "$path" >/dev/null 2>"$work/jq-error" || fail "access-log page shape or malformed-record assertion failed"
}

page_record_count_read() {
  local path="$1" count
  count="$(jq -e '.data.records | length' "$path" 2>"$work/jq-error")" || {
    fail "access-log page record count could not be read"
  }
  [[ "$count" =~ ^[0-9]+$ ]] || fail "access-log page record count is invalid"
  printf '%s' "$count"
}

page_next_cursor_read() {
  local path="$1" next
  next="$(jq -e -r '
    if .success != true or (.data | type) != "object" or
      (.data.next != null and ((.data.next | type) != "string" or (.data.next | length) == 0 or (.data.next | length) > 4096))
    then error("access-log next cursor is invalid")
    elif .data.next == null then ""
    else .data.next
    end
  ' "$path" 2>"$work/jq-error")" || fail "access-log next cursor is invalid"
  printf '%s' "$next"
}

page_has_record_assert() {
  local path="$1" id="$2" host="$3" uri="$4" cookie="$5" authorization="$6"
  local uri_file cookie_file authorization_file
  secret_comparison_file_create "$uri"
  uri_file="$secret_comparison_file_path"
  secret_comparison_file_create "$cookie"
  cookie_file="$secret_comparison_file_path"
  secret_comparison_file_create "$authorization"
  authorization_file="$secret_comparison_file_path"
  jq -e --arg id "$id" --arg host "$host" \
    --rawfile uri "$uri_file" --rawfile cookie "$cookie_file" \
    --rawfile authorization "$authorization_file" '
    any(.data.records[]?;
      .logger == ("http.log.access." + $id) and
      .request.host == $host and
      .request.method == "GET" and
      .request.uri == $uri and
      (.request.headers | type == "object") and
      (.resp_headers | type == "object") and
      (.status | type == "number") and
      (.duration | type == "number") and
      (.size | type == "number") and
       (((.request.headers.Authorization // []) | index("Bearer " + $authorization)) != null) and
       (((.request.headers.Cookie // []) | index("e2e-cookie=" + $cookie)) != null)
    )
  ' "$path" >/dev/null 2>"$work/jq-error" || return 1
}

page_project_scope_assert() {
  local path="$1" expected_id="$2" expected_host="$3"
  local foreign_id="$4" foreign_host="$5" foreign_uri_fragment="$6" foreign_cookie="$7" foreign_authorization="$8"
  local foreign_uri_file foreign_cookie_file foreign_authorization_file
  secret_comparison_file_create "$foreign_uri_fragment"
  foreign_uri_file="$secret_comparison_file_path"
  secret_comparison_file_create "$foreign_cookie"
  foreign_cookie_file="$secret_comparison_file_path"
  secret_comparison_file_create "$foreign_authorization"
  foreign_authorization_file="$secret_comparison_file_path"
  jq -e \
    --arg expected_id "$expected_id" \
    --arg expected_host "$expected_host" \
    --arg foreign_id "$foreign_id" \
    --arg foreign_host "$foreign_host" \
    --rawfile foreign_uri_fragment "$foreign_uri_file" \
    --rawfile foreign_cookie "$foreign_cookie_file" \
    --rawfile foreign_authorization "$foreign_authorization_file" '
      (.data.records | all(.[]?;
        type == "object" and
        .logger == ("http.log.access." + $expected_id) and
        .request.host == $expected_host
      )) and
      (.data.records | (any(.[]?;
        ((.logger // "") == ("http.log.access." + $foreign_id)) or
        ((.request.host // "") == $foreign_host) or
        ((.request.uri // "") | contains($foreign_uri_fragment)) or
         (((.request.headers.Authorization // []) | index("Bearer " + $foreign_authorization)) != null) or
         (((.request.headers.Cookie // []) | index("e2e-cookie=" + $foreign_cookie)) != null)
      ) | not))
    ' "$path" >/dev/null 2>"$work/jq-error" || fail "project access-log logger, host, or isolation assertion failed"
}

page_extract_record() {
  local input="$1" output="$2" id="$3" host="$4" uri="$5" cookie="$6" authorization="$7"
  local uri_file cookie_file authorization_file
  secret_comparison_file_create "$uri"
  uri_file="$secret_comparison_file_path"
  secret_comparison_file_create "$cookie"
  cookie_file="$secret_comparison_file_path"
  secret_comparison_file_create "$authorization"
  authorization_file="$secret_comparison_file_path"
  jq -S -c --arg id "$id" --arg host "$host" \
    --rawfile uri "$uri_file" --rawfile cookie "$cookie_file" \
    --rawfile authorization "$authorization_file" '
    [ .data.records[]?
      | select(
        type == "object" and
        .logger == ("http.log.access." + $id) and
        .request.host == $host and
        .request.method == "GET" and
        .request.uri == $uri and
         (((.request.headers.Authorization // []) | index("Bearer " + $authorization)) != null) and
         (((.request.headers.Cookie // []) | index("e2e-cookie=" + $cookie)) != null)
        )
    ] | if length == 1 then .[0] else error("expected exactly one tagged access-log record") end
  ' "$input" >"$output" 2>"$work/jq-error" || fail "access-log record extraction failed"
}

filesystem_extract_record() {
  local directory="$1" output="$2" id="$3" host="$4" uri="$5" cookie="$6" authorization="$7"
  local source="${8:-all}" archive_base name
  local candidates="${output}.candidates" path usage_file source_usage_file
  local scanned_bytes=0 decompressed_bytes=0 record_count=0
  local -a usage_values=()
  local -a source_usage_values=()
  local -a files=()
  local -a archive_bases=()
  local -A archive_plain_paths=() archive_gzip_paths=() archive_seen=()
  local uri_file cookie_file authorization_file

  secret_comparison_file_create "$uri"
  uri_file="$secret_comparison_file_path"
  secret_comparison_file_create "$cookie"
  cookie_file="$secret_comparison_file_path"
  secret_comparison_file_create "$authorization"
  authorization_file="$secret_comparison_file_path"

  [[ "$source" == all || "$source" == archive || "$source" == active ]] || fail "invalid filesystem access-log source"
  no_symlink_ancestor_validate "$directory" "project access-log"
  [[ ! -L "$directory" && -d "$directory" ]] || fail "project access-log directory is unavailable"
  project_entries_validate "$directory" no >/dev/null

  if [[ "$source" != archive && ( -e "$directory/access.jsonl" || -L "$directory/access.jsonl" ) ]]; then
    files+=("$directory/access.jsonl")
  fi
  if [[ "$source" != active ]]; then
    for path in "$directory"/access-*.jsonl "$directory"/access-*.jsonl.gz; do
      [[ -e "$path" || -L "$path" ]] || continue
      name="${path##*/}"
      archive_name_is_valid "$name" || fail "unexpected project access-log entry"
      if [[ "$name" == *.gz ]]; then
        archive_base="${name%.gz}"
        [[ -z "${archive_gzip_paths[$archive_base]+seen}" ]] || fail "project has duplicate gzip access-log archives"
        archive_gzip_paths["$archive_base"]="$path"
      else
        archive_base="$name"
        [[ -z "${archive_plain_paths[$archive_base]+seen}" ]] || fail "project has duplicate plain access-log archives"
        archive_plain_paths["$archive_base"]="$path"
      fi
      if [[ -z "${archive_seen[$archive_base]+seen}" ]]; then
        archive_seen["$archive_base"]=1
        archive_bases[${#archive_bases[@]}]="$archive_base"
      fi
    done
    for archive_base in "${archive_bases[@]}"; do
      # Caddy can briefly retain both representations while compressing. Treat
      # that same-base pair as one archive and prefer the completed plain file;
      # a later observation retries with gzip after the plain file is removed.
      if [[ -n "${archive_plain_paths[$archive_base]+seen}" ]]; then
        files+=("${archive_plain_paths[$archive_base]}")
      elif [[ -n "${archive_gzip_paths[$archive_base]+seen}" ]]; then
        files+=("${archive_gzip_paths[$archive_base]}")
      fi
    done
  fi
  ((${#files[@]} > 0)) || fail "project access-log files are unavailable"

  : >"$candidates" || fail "filesystem access-log candidates cannot be created"
  for path in "${files[@]}"; do
    [[ ! -L "$path" && -f "$path" ]] || fail "project access-log source is missing or symbolic"
    source_usage_file="$work/filesystem-source-usage"
    usage_file="$work/filesystem-stream-usage"
    : >"$source_usage_file" || fail "filesystem access-log source bounds cannot be recorded"
    : >"$usage_file" || fail "filesystem access-log bounds cannot be recorded"
    case "$path" in
      *.jsonl.gz)
        if ! bounded_file_stream "$maximum_access_log_scanned_bytes" "$scanned_bytes" "$source_usage_file" <"$path" |
          gzip -cd 2>"$work/gzip-error" |
          bounded_jsonl_stream "$maximum_access_log_line_bytes" "$maximum_access_log_records" \
            "$maximum_access_log_decompressed_bytes" "$decompressed_bytes" "$record_count" "$usage_file" |
          jq -S -c --arg id "$id" --arg host "$host" \
            --rawfile uri "$uri_file" --rawfile cookie "$cookie_file" \
            --rawfile authorization "$authorization_file" '
              select(
                type == "object" and
                .logger == ("http.log.access." + $id) and
                .request.host == $host and
                .request.method == "GET" and
                .request.uri == $uri and
                 (((.request.headers.Authorization // []) | index("Bearer " + $authorization)) != null) and
                 (((.request.headers.Cookie // []) | index("e2e-cookie=" + $cookie)) != null)
              )
            ' >>"$candidates" 2>"$work/jq-error"; then
          fail "filesystem access-log archive cannot be read"
        fi
        ;;
      *)
        if ! bounded_file_stream "$maximum_access_log_scanned_bytes" "$scanned_bytes" "$source_usage_file" <"$path" |
          bounded_jsonl_stream "$maximum_access_log_line_bytes" "$maximum_access_log_records" \
          0 "$decompressed_bytes" "$record_count" "$usage_file" |
           jq -S -c --arg id "$id" --arg host "$host" \
           --rawfile uri "$uri_file" --rawfile cookie "$cookie_file" \
           --rawfile authorization "$authorization_file" '
            select(
              type == "object" and
              .logger == ("http.log.access." + $id) and
              .request.host == $host and
              .request.method == "GET" and
              .request.uri == $uri and
               (((.request.headers.Authorization // []) | index("Bearer " + $authorization)) != null) and
               (((.request.headers.Cookie // []) | index("e2e-cookie=" + $cookie)) != null)
            )
          ' >>"$candidates" 2>"$work/jq-error"; then
          fail "filesystem access-log file cannot be read"
        fi
        ;;
    esac
    mapfile -t source_usage_values <"$source_usage_file" || fail "filesystem access-log source bounds could not be recorded"
    ((${#source_usage_values[@]} == 1)) || fail "filesystem access-log source bounds could not be recorded"
    scanned_bytes="${source_usage_values[0]}"
    [[ "$scanned_bytes" =~ ^[0-9]+$ ]] || fail "filesystem access-log scanned-byte bound is invalid"
    mapfile -t usage_values <"$usage_file" || fail "filesystem access-log bounds could not be recorded"
    ((${#usage_values[@]} == 2)) || fail "filesystem access-log bounds could not be recorded"
    record_count="${usage_values[0]}"
    decompressed_bytes="${usage_values[1]}"
    [[ "$record_count" =~ ^[0-9]+$ && "$decompressed_bytes" =~ ^[0-9]+$ ]] || {
      fail "filesystem access-log bounds are invalid"
    }
  done

  jq -S -c -s 'if length == 1 then .[0] else error("expected exactly one tagged filesystem access-log record") end' \
    "$candidates" >"$output" 2>"$work/jq-error" || fail "expected filesystem access-log record was not found exactly once"
}

bounded_file_stream() {
  local scan_limit="$1" initial_scanned="$2" usage_file="$3"
  python3 -c '
import sys

scan_limit = int(sys.argv[1])
scanned_bytes = int(sys.argv[2])
usage_file = sys.argv[3]

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

if scanned_bytes > scan_limit:
    fail("access log scanned-byte limit exceeded")

while True:
    remaining = scan_limit - scanned_bytes
    chunk = sys.stdin.buffer.read(min(64 * 1024, remaining + 1))
    if not chunk:
        break
    scanned_bytes += len(chunk)
    if scanned_bytes > scan_limit:
        fail("access log scanned-byte limit exceeded")
    try:
        sys.stdout.buffer.write(chunk)
    except BrokenPipeError:
        raise SystemExit(1)

with open(usage_file, "w", encoding="ascii") as usage:
    usage.write(f"{scanned_bytes}\n")
' "$scan_limit" "$initial_scanned" "$usage_file"
}

bounded_jsonl_stream() {
  local line_limit="$1" record_limit="$2" decompressed_limit="$3"
  local initial_decompressed="$4" initial_records="$5" usage_file="$6"
  python3 -c '
import sys

line_limit = int(sys.argv[1])
record_limit = int(sys.argv[2])
decompressed_limit = int(sys.argv[3])
decompressed_bytes = int(sys.argv[4])
record_count = int(sys.argv[5])
usage_file = sys.argv[6]
pending = bytearray()

def fail(message):
    print(message, file=sys.stderr)
    raise SystemExit(1)

def write_line(line):
    global record_count
    logical_length = len(line) - (1 if line.endswith(b"\r") else 0)
    if logical_length > line_limit:
        fail("access log line is too large")
    record_count += 1
    if record_count > record_limit:
        fail("access log record limit exceeded")
    sys.stdout.buffer.write(line)
    sys.stdout.buffer.write(b"\n")

while True:
    if decompressed_limit > 0:
        remaining = decompressed_limit - decompressed_bytes
        chunk_size = min(64 * 1024, remaining + 1)
    else:
        chunk_size = 64 * 1024
    chunk = sys.stdin.buffer.read(max(1, chunk_size))
    if not chunk:
        break
    if decompressed_limit > 0:
        decompressed_bytes += len(chunk)
        if decompressed_bytes > decompressed_limit:
            fail("access log decompressed-byte limit exceeded")
    pending.extend(chunk)
    while True:
        newline = pending.find(b"\n")
        if newline < 0:
            if len(pending) > line_limit + 1:
                fail("access log line is too large")
            break
        line = bytes(pending[:newline])
        del pending[: newline + 1]
        write_line(line)

if pending:
    write_line(bytes(pending))

with open(usage_file, "w", encoding="ascii") as usage:
    usage.write(f"{record_count}\n{decompressed_bytes}\n")
' "$line_limit" "$record_limit" "$decompressed_limit" "$initial_decompressed" "$initial_records" "$usage_file"
}

record_compare_assert() {
  local filesystem="$1" http="$2" label="$3" cli
  shift 3
  cmp -s "$filesystem" "$http" || fail "filesystem and HTTP $label records differ"
  for cli in "$@"; do
    cmp -s "$filesystem" "$cli" || fail "filesystem and Unix $label records differ"
  done
}

cache_control_assert() {
  local headers="$1"
  awk '
    BEGIN { found = 0 }
    tolower($0) ~ /^[[:space:]]*cache-control:[[:space:]]*no-store([[:space:]]|;|$)/ { found = 1 }
    END { exit(found ? 0 : 1) }
  ' "$headers" >/dev/null 2>&1 || fail "access-log HTTP response is not no-store"
}

api_request() {
  local headers_file="$1" owner="$2" project="$3" body="$4" response_headers="$5" status_file="$6"
  local before="${7:-}"
  local status curl_status capture_status capture_pid fifo
  local -a query_args=(--get --data-urlencode "limit=$access_log_api_page_limit")
  if [[ -n "$before" ]]; then
    query_args+=(--data-urlencode "before=$before")
  fi
  fifo="$body.pipe"
  mkfifo -- "$fifo" || return 1
  exec 3<>"$fifo" || {
    rm -f -- "$fifo"
    return 1
  }
  exec 4<"$fifo" || {
    exec 3>&-
    rm -f -- "$fifo"
    return 1
  }
  (
    exec 0<&4
    exec 3>&-
    exec 4>&-
    bounded_response_capture "$body"
  ) &
  capture_pid=$!
  if status="$(curl --silent --show-error --max-time 10 --connect-timeout 10 \
    --max-filesize "$maximum_page_bytes" \
    --header "@$headers_file" \
    --dump-header "$response_headers" \
    --output "$fifo" \
    --write-out '%{http_code}' \
     "${query_args[@]}" \
     "$api_url/api/v1/users/$owner/projects/$project/access-logs" \
     2>"$work/curl-error")"; then
    curl_status=0
  else
    curl_status=$?
  fi
  exec 4>&-
  exec 3>&-
  if ((curl_status != 0)) && kill -0 "$capture_pid" 2>/dev/null; then
    kill "$capture_pid" 2>/dev/null || true
  fi
  if wait "$capture_pid"; then
    capture_status=0
  else
    capture_status=$?
  fi
  rm -f -- "$fifo" || return 1
  ((curl_status == 0 && capture_status == 0)) || return 1
  printf '%s' "$status" >"$status_file"
  [[ "$status" =~ ^[1-5][0-9][0-9]$ ]]
}

http_unauthorized_assert() {
  local headers_file="$1" owner="$2" project="$3" label="$4"
  local body="$work/cross-http-$label.json"
  local response_headers="$work/cross-http-$label.headers"
  local status_file="$work/cross-http-$label.status"
  api_request "$headers_file" "$owner" "$project" "$body" "$response_headers" "$status_file" || {
    fail "cross-owner HTTP authorization request could not be completed"
  }
  [[ "$(<"$status_file")" == 404 ]] || fail "cross-owner HTTP authorization did not fail closed"
  jq -e '.success == false and .error.status == 404' "$body" >/dev/null 2>"$work/jq-error" || {
    fail "cross-owner HTTP authorization status was not 404"
  }
  cache_control_assert "$response_headers"
}

caddy_request_config() {
  local config="$1" host="$2" query="$3" cookie="$4" authorization="$5"
  {
    printf 'url = "%s%s?e2e-query-secret=%s"\n' "$caddy_url" "$request_path" "$query"
    printf 'header = "Host: %s"\n' "$host"
    printf 'header = "Cookie: e2e-cookie=%s"\n' "$cookie"
    printf 'header = "Authorization: Bearer %s"\n' "$authorization"
    printf 'output = "/dev/null"\n'
    printf 'silent\nshow-error\nmax-time = 10\nconnect-timeout = 10\n'
    if ((insecure == 1)); then
      printf 'insecure\n'
    fi
    printf 'write-out = "%%{http_code}"\n'
  } >"$config"
}

caddy_request() {
  local host="$1" query="$2" cookie="$3" authorization="$4" label="$5" status_file="$6"
  local config="$work/request-$label.conf" status
  caddy_request_config "$config" "$host" "$query" "$cookie" "$authorization"
  if ! status="$(curl --config "$config" 2>"$work/caddy-error")"; then
    return 1
  fi
  [[ "$status" =~ ^2[0-9][0-9]$ ]] || return 1
  printf '%s' "$status" >"$status_file" || return 1
}

record_status_assert() {
  local path="$1" expected_status="$2" label="$3"
  [[ "$expected_status" =~ ^2[0-9][0-9]$ ]] || fail "observed Caddy status for $label is invalid"
  jq -e --argjson expected_status "$expected_status" \
    '.status == $expected_status' "$path" >/dev/null 2>"$work/jq-error" || \
    fail "selected $label access-log record status did not match observed Caddy response"
}

rotation_status_assert() {
  local expected_count="$1"
  awk -v expected_count="$expected_count" '
    {
      gsub(/^[[:space:]]+|[[:space:]]+$/, "")
      if ($0 !~ /^2[0-9][0-9]$/) {
        exit 1
      }
      count += 1
    }
    END { exit(count != expected_count) }
  ' >/dev/null 2>&1
}

wait_for_archive_record() {
  local directory="$1" output="$2" id="$3" host="$4" uri="$5" cookie="$6" authorization="$7" label="$8"
  local attempt
  for ((attempt = 0; attempt < rotation_observation_attempts; attempt += 1)); do
    if (filesystem_extract_record "$directory" "$output" "$id" "$host" "$uri" "$cookie" "$authorization" archive) \
      2>"$work/filesystem-$label-error"; then
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for the $label pre-marker in a rotated access-log archive"
}

wait_for_record() {
  local headers_file="$1" owner="$2" project="$3" body="$4" response_headers="$5" status_file="$6"
  local id="$7" host="$8" uri="$9" cookie="${10}" authorization="${11}" label="${12}"
  local foreign_id="${13}" foreign_host="${14}" foreign_uri_fragment="${15}"
  local foreign_cookie="${16}" foreign_authorization="${17}"
  local attempt
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    if api_request "$headers_file" "$owner" "$project" "$body" "$response_headers" "$status_file" &&
      [[ "$(<"$status_file")" == 200 ]] &&
      page_shape_assert "$body" &&
      page_project_scope_assert "$body" "$id" "$host" "$foreign_id" "$foreign_host" \
        "$foreign_uri_fragment" "$foreign_cookie" "$foreign_authorization" &&
      page_has_record_assert "$body" "$id" "$host" "$uri" "$cookie" "$authorization"; then
      cache_control_assert "$response_headers"
      return 0
    fi
    sleep 1
  done
  fail "timed out waiting for the $label Caddy record"
}

wait_for_rotation_continuity() {
  local headers_file="$1" owner="$2" project="$3" body="$4" response_headers="$5" status_file="$6"
  local id="$7" host="$8" uri="$9" cookie="${10}" authorization="${11}"
  local post_uri="${12}" post_cookie="${13}" post_authorization="${14}"
  local foreign_id="${15}" foreign_host="${16}" foreign_uri_fragment="${17}"
  local foreign_cookie="${18}" foreign_authorization="${19}"
  local attempt page_path next_cursor before page_count page_records aggregate_records
  for ((attempt = 0; attempt < 30; attempt += 1)); do
    page_path="$body"
    before=""
    page_count=0
    aggregate_records=0
    if api_request "$headers_file" "$owner" "$project" "$body" "$response_headers" "$status_file" &&
      [[ "$(<"$status_file")" == 200 ]] &&
      page_shape_assert "$body" &&
      page_bytes_assert "$body" &&
      page_project_scope_assert "$body" "$id" "$host" "$foreign_id" "$foreign_host" \
        "$foreign_uri_fragment" "$foreign_cookie" "$foreign_authorization" &&
       page_has_record_assert "$body" "$id" "$host" "$post_uri" "$post_cookie" "$post_authorization"; then
      page_count=1
      page_records="$(page_record_count_read "$page_path")"
      aggregate_records=$((aggregate_records + page_records))
      ((aggregate_records <= maximum_rotation_api_records)) || {
        fail "rotation access-log paging exceeded the bounded record aggregate"
      }
      if page_has_record_assert "$page_path" "$id" "$host" "$uri" "$cookie" "$authorization"; then
        cache_control_assert "$response_headers"
        return 0
      fi

      while ((page_count < maximum_rotation_api_pages)); do
        next_cursor="$(page_next_cursor_read "$page_path")"
        [[ -n "$next_cursor" ]] || break
        before="$next_cursor"
        if ! api_request "$headers_file" "$owner" "$project" "$body.older" \
          "$response_headers" "$status_file" "$before"; then
          break
        fi
        [[ "$(<"$status_file")" != 410 ]] || {
          fail "rotation access-log paging cursor expired"
        }
        [[ "$(<"$status_file")" == 200 ]] || break
        page_path="$body.older"
        page_shape_assert "$page_path"
        page_bytes_assert "$page_path"
        page_project_scope_assert "$page_path" "$id" "$host" "$foreign_id" "$foreign_host" \
          "$foreign_uri_fragment" "$foreign_cookie" "$foreign_authorization"
        page_count=$((page_count + 1))
        page_records="$(page_record_count_read "$page_path")"
        aggregate_records=$((aggregate_records + page_records))
        ((aggregate_records <= maximum_rotation_api_records)) || {
          fail "rotation access-log paging exceeded the bounded record aggregate"
        }
        if page_has_record_assert "$page_path" "$id" "$host" "$uri" "$cookie" "$authorization"; then
          cache_control_assert "$response_headers"
          return 0
        fi
      done
      ((page_count < maximum_rotation_api_pages)) || {
        fail "rotation access-log paging exceeded the bounded page limit"
      }
      ((aggregate_records < maximum_rotation_api_records)) || {
        fail "rotation access-log paging exceeded the bounded record aggregate"
      }
    elif [[ -f "$status_file" && "$(<"$status_file")" == 410 ]]; then
      fail "rotation access-log paging cursor expired"
    fi
    sleep 1
  done
  fail "rotated access-log records were not continuous"
}

cli_authorized() {
  local socket="$1" owner="$2" project="$3" output="$4" explicit_owner="$5"
  local expected_id="$6" expected_host="$7" foreign_id="$8" foreign_host="$9"
  local foreign_uri_fragment="${10}" foreign_cookie="${11}" foreign_authorization="${12}"
  local -a args=(--socket "$socket" project access-logs "$project" --limit 1000 --json)
  if [[ "$explicit_owner" == yes ]]; then
    args+=(--owner "$owner")
  fi
  if ! USER="$owner" timeout 10 "$cli" "${args[@]}" 2>"$work/cli-error" |
    bounded_response_capture "$output"; then
    return 1
  fi
  page_bytes_assert "$output"
  jq -e '
    .success == true and
    (.data | type == "object") and
    (.data.records | type == "array") and
    (.data.records | length <= 1000) and
    (.data.partial == false) and
    (.data.malformedLines == 0)
   ' "$output" >/dev/null 2>"$work/jq-error" || fail "Unix access-log page shape assertion failed"
  page_project_scope_assert "$output" "$expected_id" "$expected_host" "$foreign_id" "$foreign_host" \
    "$foreign_uri_fragment" "$foreign_cookie" "$foreign_authorization"
}

cli_unauthorized_assert() {
  local socket="$1" actor="$2" owner="$3" project="$4" label="$5"
  local output="$work/unauthorized-cli-$label.json"
  local error="$work/unauthorized-cli-$label-error"
  local output_fifo="$output.pipe" error_fifo="$error.pipe"
  local output_capture_pid error_capture_pid exit_code output_capture_status error_capture_status
  mkfifo -- "$output_fifo" "$error_fifo" || return 1
  bounded_stream_capture "$output" <"$output_fifo" &
  output_capture_pid=$!
  bounded_stream_capture "$error" <"$error_fifo" &
  error_capture_pid=$!
  set +e
  USER="$actor" timeout 10 "$cli" --socket "$socket" project access-logs "$project" --owner "$owner" --limit 1000 --json \
    >"$output_fifo" 2>"$error_fifo"
  exit_code=$?
  wait "$output_capture_pid"
  output_capture_status=$?
  wait "$error_capture_pid"
  error_capture_status=$?
  set -e
  rm -f -- "$output_fifo" "$error_fifo" || return 1
  if ((output_capture_status == bounded_stream_capture_overflow_status ||
    error_capture_status == bounded_stream_capture_overflow_status)); then
    return 1
  fi
  ((output_capture_status == 0 && error_capture_status == 0)) || return 1
  ((exit_code == 1)) || fail "Unix authorization did not fail closed"
  page_bytes_assert "$output"
  page_bytes_assert "$error"
  [[ ! -s "$output" ]] || fail "unauthorized Unix request returned data"
  jq -e '.success == false and .error.status == 404' "$error" >/dev/null 2>"$work/jq-error" || {
    fail "Unix authorization status did not match HTTP 404"
  }
}

project_disk_assert() {
  local directory="$1"
  local bytes
  bytes="$(du -sb -- "$directory" | awk 'NR == 1 { print $1 }')" || fail "access-log disk usage could not be measured"
  [[ "$bytes" =~ ^[0-9]+$ ]] || fail "access-log disk usage is invalid"
  ((bytes <= maximum_project_bytes)) || fail "project access-log disk usage exceeded the bounded retention budget"
}

validate_local() {
  local command_name
  for command_name in awk cmp curl dd du getent gzip id jq mkfifo mktemp od python3 sha256sum stat timeout tr wc; do
    command_require "$command_name"
  done
  printf '%s\n' "$script_name local validation ok"
}

mode=""
api_url=""
caddy_url=""
api_headers_a=""
api_headers_b=""
unix_socket_a=""
unix_socket_b=""
cli=""
log_root=""
staging_attestation=""
deployment_id=""
owner_a=""
owner_b=""
project_a=""
project_b=""
host_a=""
host_b=""
request_path=""
rotation_count=""
insecure=0
declare -A seen_options=()

while (($# > 0)); do
  case "$1" in
    --help|-h)
      help
      exit 0
      ;;
    --validate)
      [[ -z "$mode" ]] || { printf 'only one mode may be selected\n' >&2; exit 2; }
      mode="validate"
      ;;
    --run)
      [[ -z "$mode" ]] || { printf 'only one mode may be selected\n' >&2; exit 2; }
      mode="run"
      ;;
    --insecure)
      [[ -z "${seen_options[$1]+seen}" ]] || { printf 'option may only be provided once: %s\n' "$1" >&2; exit 2; }
      seen_options[$1]=1
      insecure=1
      ;;
    --api-url|--caddy-url|--api-headers-a|--api-headers-b|--unix-socket-a|--unix-socket-b|--cli|--log-root|--staging-attestation|--owner-a|--owner-b|--project-a|--project-b|--host-a|--host-b|--request-path|--rotation-count)
      option="$1"
      [[ -z "${seen_options[$option]+seen}" ]] || { printf 'option may only be provided once: %s\n' "$option" >&2; exit 2; }
      seen_options[$option]=1
      value="$(argument_value "$option" "${2:-}")"
      shift
      case "$option" in
        --api-url) api_url="$value" ;;
        --caddy-url) caddy_url="$value" ;;
        --api-headers-a) api_headers_a="$value" ;;
        --api-headers-b) api_headers_b="$value" ;;
        --unix-socket-a) unix_socket_a="$value" ;;
        --unix-socket-b) unix_socket_b="$value" ;;
        --cli) cli="$value" ;;
        --log-root) log_root="$value" ;;
        --staging-attestation) staging_attestation="$value" ;;
        --owner-a) owner_a="$value" ;;
        --owner-b) owner_b="$value" ;;
        --project-a) project_a="$value" ;;
        --project-b) project_b="$value" ;;
        --host-a) host_a="$value" ;;
        --host-b) host_b="$value" ;;
        --request-path) request_path="$value" ;;
        --rotation-count) rotation_count="$value" ;;
      esac
      ;;
    *)
      printf 'unknown argument: %s\n' "$1" >&2
      exit 2
      ;;
  esac
  shift
done

if [[ "$mode" == validate ]]; then
  validate_local
  exit 0
fi
[[ "$mode" == run ]] || {
  printf '%s\n' "--run or --validate is required" >&2
  help >&2
  exit 2
}

for required_value in "$api_url" "$caddy_url" "$api_headers_a" "$api_headers_b" "$unix_socket_a" "$unix_socket_b" \
  "$cli" "$log_root" "$staging_attestation" "$owner_a" "$owner_b" "$project_a" "$project_b" "$host_a" "$host_b" \
  "$request_path" "$rotation_count"; do
  [[ -n "$required_value" ]] || fail "all --run target and configuration inputs are required"
done

url_validate "$api_url"
url_validate "$caddy_url"
api_url="${api_url%/}"
caddy_url="${caddy_url%/}"
absolute_path_validate "$api_headers_a"
absolute_path_validate "$api_headers_b"
absolute_path_validate "$unix_socket_a"
absolute_path_validate "$unix_socket_b"
absolute_path_validate "$cli"
absolute_path_validate "$log_root"
absolute_path_validate "$staging_attestation"
owner_validate "$owner_a"
owner_validate "$owner_b"
project_validate "$project_a"
project_validate "$project_b"
host_validate "$host_a"
host_validate "$host_b"
request_path_validate "$request_path"
[[ "$owner_a" != "$owner_b" && "$project_a" != "$project_b" && "$host_a" != "$host_b" ]] || {
  fail "staging owners, projects, and Caddy hosts must be distinct"
}
[[ "$rotation_count" =~ ^[1-9][0-9]*$ && "$rotation_count" -le "$maximum_rotation_request_count" ]] || fail "rotation count is not safely bounded"

validate_local
executable_validate "$cli"
staging_attestation_validate
secret_file_validate "$api_headers_a"
secret_file_validate "$api_headers_b"
socket_validate "$unix_socket_a"
socket_validate "$unix_socket_b"
identity_resolve
root_validate

project_id_a="$(project_id "$owner_a" "$project_a")"
project_id_b="$(project_id "$owner_b" "$project_b")"
project_directory_a="$(project_directory "$owner_a" "$project_a")"
project_directory_b="$(project_directory "$owner_b" "$project_b")"
project_fresh_validate "$project_directory_a"
project_fresh_validate "$project_directory_b"

work="$(mktemp -d "${TMPDIR:-/tmp}/project-registry-caddy-e2e.XXXXXX")" || fail "temporary workspace could not be created"
trap 'rm -rf -- "$work"' EXIT

run_token="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')" || fail "test marker generation failed"
[[ "$run_token" =~ ^[0-9a-f]{32}$ ]] || fail "test marker generation failed"
query_a="project-registry-e2e-query-${run_token}-a"
cookie_a="project-registry-e2e-cookie-${run_token}-a"
authorization_a="project-registry-e2e-authorization-${run_token}-a"
query_b="project-registry-e2e-query-${run_token}-b"
cookie_b="project-registry-e2e-cookie-${run_token}-b"
authorization_b="project-registry-e2e-authorization-${run_token}-b"
rotation_query="project-registry-e2e-rotation-${run_token}"
rotation_cookie="project-registry-e2e-rotation-cookie-${run_token}"
rotation_authorization="project-registry-e2e-rotation-authorization-${run_token}"
rotation_before_query="project-registry-e2e-rotation-before-${run_token}"
rotation_before_cookie="project-registry-e2e-rotation-before-cookie-${run_token}"
rotation_before_authorization="project-registry-e2e-rotation-before-authorization-${run_token}"
rotation_after_query="project-registry-e2e-rotation-after-${run_token}"
rotation_after_cookie="project-registry-e2e-rotation-after-cookie-${run_token}"
rotation_after_authorization="project-registry-e2e-rotation-after-authorization-${run_token}"
uri_a="$request_path?e2e-query-secret=$query_a"
uri_b="$request_path?e2e-query-secret=$query_b"
rotation_uri="$request_path?e2e-query-secret=$rotation_query"
rotation_before_uri="$request_path?e2e-query-secret=$rotation_before_query"
rotation_after_uri="$request_path?e2e-query-secret=$rotation_after_query"

caddy_request "$host_a" "$query_a" "$cookie_a" "$authorization_a" a "$work/caddy-a.status" || fail "Caddy did not accept the owner A staging request"
caddy_request "$host_b" "$query_b" "$cookie_b" "$authorization_b" b "$work/caddy-b.status" || fail "Caddy did not accept the owner B staging request"

http_a="$work/http-a.json"
http_a_headers="$work/http-a.headers"
http_a_status="$work/http-a.status"
http_b="$work/http-b.json"
http_b_headers="$work/http-b.headers"
http_b_status="$work/http-b.status"
wait_for_record "$api_headers_a" "$owner_a" "$project_a" "$http_a" "$http_a_headers" "$http_a_status" \
  "$project_id_a" "$host_a" "$uri_a" "$cookie_a" "$authorization_a" A \
  "$project_id_b" "$host_b" "$query_b" "$cookie_b" "$authorization_b"
wait_for_record "$api_headers_b" "$owner_b" "$project_b" "$http_b" "$http_b_headers" "$http_b_status" \
  "$project_id_b" "$host_b" "$uri_b" "$cookie_b" "$authorization_b" B \
  "$project_id_a" "$host_a" "$query_a" "$cookie_a" "$authorization_a"
page_bytes_assert "$http_a"
page_bytes_assert "$http_b"

cli_a_explicit="$work/cli-a-explicit.json"
cli_a_inferred="$work/cli-a-inferred.json"
cli_b_explicit="$work/cli-b-explicit.json"
cli_b_inferred="$work/cli-b-inferred.json"
cli_authorized "$unix_socket_a" "$owner_a" "$project_a" "$cli_a_explicit" yes \
  "$project_id_a" "$host_a" "$project_id_b" "$host_b" "$query_b" "$cookie_b" "$authorization_b" || \
  fail "authorized owner A CLI request failed"
cli_authorized "$unix_socket_a" "$owner_a" "$project_a" "$cli_a_inferred" no \
  "$project_id_a" "$host_a" "$project_id_b" "$host_b" "$query_b" "$cookie_b" "$authorization_b" || \
  fail "owner-inferred owner A CLI request failed"
cli_authorized "$unix_socket_b" "$owner_b" "$project_b" "$cli_b_explicit" yes \
  "$project_id_b" "$host_b" "$project_id_a" "$host_a" "$query_a" "$cookie_a" "$authorization_a" || \
  fail "authorized owner B CLI request failed"
cli_authorized "$unix_socket_b" "$owner_b" "$project_b" "$cli_b_inferred" no \
  "$project_id_b" "$host_b" "$project_id_a" "$host_a" "$query_a" "$cookie_a" "$authorization_a" || \
  fail "owner-inferred owner B CLI request failed"

page_extract_record "$http_a" "$work/http-a-selected.json" "$project_id_a" "$host_a" "$uri_a" "$cookie_a" "$authorization_a"
page_extract_record "$cli_a_explicit" "$work/cli-a-explicit-selected.json" "$project_id_a" "$host_a" "$uri_a" "$cookie_a" "$authorization_a"
page_extract_record "$cli_a_inferred" "$work/cli-a-inferred-selected.json" "$project_id_a" "$host_a" "$uri_a" "$cookie_a" "$authorization_a"
page_extract_record "$http_b" "$work/http-b-selected.json" "$project_id_b" "$host_b" "$uri_b" "$cookie_b" "$authorization_b"
page_extract_record "$cli_b_explicit" "$work/cli-b-explicit-selected.json" "$project_id_b" "$host_b" "$uri_b" "$cookie_b" "$authorization_b"
page_extract_record "$cli_b_inferred" "$work/cli-b-inferred-selected.json" "$project_id_b" "$host_b" "$uri_b" "$cookie_b" "$authorization_b"
filesystem_extract_record "$project_directory_a" "$work/filesystem-a.json" "$project_id_a" "$host_a" "$uri_a" "$cookie_a" "$authorization_a"
filesystem_extract_record "$project_directory_b" "$work/filesystem-b.json" "$project_id_b" "$host_b" "$uri_b" "$cookie_b" "$authorization_b"
record_status_assert "$work/http-a-selected.json" "$(<"$work/caddy-a.status")" "owner A HTTP"
record_status_assert "$work/cli-a-explicit-selected.json" "$(<"$work/caddy-a.status")" "owner A explicit Unix"
record_status_assert "$work/cli-a-inferred-selected.json" "$(<"$work/caddy-a.status")" "owner A inferred Unix"
record_status_assert "$work/filesystem-a.json" "$(<"$work/caddy-a.status")" "owner A filesystem"
record_status_assert "$work/http-b-selected.json" "$(<"$work/caddy-b.status")" "owner B HTTP"
record_status_assert "$work/cli-b-explicit-selected.json" "$(<"$work/caddy-b.status")" "owner B explicit Unix"
record_status_assert "$work/cli-b-inferred-selected.json" "$(<"$work/caddy-b.status")" "owner B inferred Unix"
record_status_assert "$work/filesystem-b.json" "$(<"$work/caddy-b.status")" "owner B filesystem"
record_compare_assert "$work/filesystem-a.json" "$work/http-a-selected.json" A \
  "$work/cli-a-explicit-selected.json" "$work/cli-a-inferred-selected.json"
record_compare_assert "$work/filesystem-b.json" "$work/http-b-selected.json" B \
  "$work/cli-b-explicit-selected.json" "$work/cli-b-inferred-selected.json"

http_unauthorized_assert "$api_headers_a" "$owner_b" "$project_b" a-to-b
http_unauthorized_assert "$api_headers_b" "$owner_a" "$project_a" b-to-a
cli_unauthorized_assert "$unix_socket_a" "$owner_a" "$owner_b" "$project_b" a-to-b
cli_unauthorized_assert "$unix_socket_b" "$owner_b" "$owner_a" "$project_a" b-to-a

project_entries_validate "$project_directory_a" no >/dev/null
project_entries_validate "$project_directory_b" no >/dev/null
project_disk_assert "$project_directory_a"
project_disk_assert "$project_directory_b"

archive_before="$(archive_count_read "$project_directory_a")"
((archive_before == 0)) || fail "owner A staging project gained an archive before the rotation phase"
caddy_request "$host_a" "$rotation_before_query" "$rotation_before_cookie" \
  "$rotation_before_authorization" rotation-before "$work/caddy-rotation-before.status" || {
  fail "pre-rotation Caddy request failed"
}
rotation_before_page="$work/http-a-rotation-before.json"
rotation_before_headers="$work/http-a-rotation-before.headers"
rotation_before_status="$work/http-a-rotation-before.status"
wait_for_record "$api_headers_a" "$owner_a" "$project_a" "$rotation_before_page" \
  "$rotation_before_headers" "$rotation_before_status" "$project_id_a" "$host_a" \
  "$rotation_before_uri" "$rotation_before_cookie" "$rotation_before_authorization" rotation-before \
  "$project_id_b" "$host_b" "$query_b" "$cookie_b" "$authorization_b"
page_extract_record "$rotation_before_page" "$work/http-a-rotation-before-selected.json" \
  "$project_id_a" "$host_a" "$rotation_before_uri" "$rotation_before_cookie" "$rotation_before_authorization"
record_status_assert "$work/http-a-rotation-before-selected.json" \
  "$(<"$work/caddy-rotation-before.status")" "rotation-before HTTP"
sent=0
while ((sent < rotation_count)); do
  remaining=$((rotation_count - sent))
  batch="$rotation_batch_size"
    ((remaining < batch)) && batch="$remaining"
    rotation_config="$work/rotation.conf"
    {
    printf 'parallel\nparallel-max = 8\nsilent\nshow-error\nmax-time = 10\nconnect-timeout = 10\n'
    if ((insecure == 1)); then
      printf 'insecure\n'
    fi
    for ((index = 0; index < batch; index += 1)); do
      printf 'url = "%s%s?e2e-query-secret=%s"\n' "$caddy_url" "$request_path" "$rotation_query"
      printf 'header = "Host: %s"\n' "$host_a"
      printf 'header = "Cookie: e2e-cookie=%s"\n' "$rotation_cookie"
      printf 'header = "Authorization: Bearer %s"\n' "$rotation_authorization"
      printf 'output = "/dev/null"\n'
    done
    printf 'write-out = "%%{http_code}\\n"\n'
  } >"$rotation_config"
  if ! curl --config "$rotation_config" 2>"$work/rotation-curl-error" |
    rotation_status_assert "$batch"; then
    fail "bounded rotation request batch failed"
  fi
  sent=$((sent + batch))
  archive_after="$(archive_count_read "$project_directory_a")"
  ((archive_after > archive_before)) && break
done
((archive_after > archive_before)) || fail "rotation did not occur within the explicit request bound"

wait_for_archive_record "$project_directory_a" "$work/filesystem-rotation-before.json" \
  "$project_id_a" "$host_a" "$rotation_before_uri" "$rotation_before_cookie" \
  "$rotation_before_authorization" rotation-before
record_status_assert "$work/filesystem-rotation-before.json" \
  "$(<"$work/caddy-rotation-before.status")" "rotation-before filesystem"
record_compare_assert "$work/filesystem-rotation-before.json" \
  "$work/http-a-rotation-before-selected.json" rotation-before

caddy_request "$host_a" "$rotation_after_query" "$rotation_after_cookie" \
  "$rotation_after_authorization" rotation-post "$work/caddy-rotation-after.status" || {
  fail "post-rotation Caddy request failed"
}
rotation_page="$work/http-a-rotation.json"
rotation_headers="$work/http-a-rotation.headers"
rotation_status="$work/http-a-rotation.status"
wait_for_rotation_continuity "$api_headers_a" "$owner_a" "$project_a" "$rotation_page" "$rotation_headers" "$rotation_status" \
  "$project_id_a" "$host_a" "$rotation_uri" "$rotation_cookie" "$rotation_authorization" \
  "$rotation_after_uri" "$rotation_after_cookie" "$rotation_after_authorization" \
  "$project_id_b" "$host_b" "$query_b" "$cookie_b" "$authorization_b"
page_extract_record "$rotation_page" "$work/http-a-rotation-after-selected.json" \
  "$project_id_a" "$host_a" "$rotation_after_uri" "$rotation_after_cookie" "$rotation_after_authorization"
filesystem_extract_record "$project_directory_a" "$work/filesystem-rotation-after.json" \
  "$project_id_a" "$host_a" "$rotation_after_uri" "$rotation_after_cookie" \
  "$rotation_after_authorization" active
record_status_assert "$work/http-a-rotation-after-selected.json" \
  "$(<"$work/caddy-rotation-after.status")" "rotation-after HTTP"
record_status_assert "$work/filesystem-rotation-after.json" \
  "$(<"$work/caddy-rotation-after.status")" "rotation-after filesystem"
record_compare_assert "$work/filesystem-rotation-after.json" \
  "$work/http-a-rotation-after-selected.json" rotation-after
page_bytes_assert "$rotation_page"

project_entries_validate "$project_directory_a" no >/dev/null
project_entries_validate "$project_directory_b" no >/dev/null
project_disk_assert "$project_directory_a"
project_disk_assert "$project_directory_b"

printf '%s\n' "$script_name passed: raw records, isolation, permissions, rotation, authorization parity, and bounds"
