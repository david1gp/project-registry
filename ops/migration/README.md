# Legacy migration

`legacy-migrate.ts` reads the existing Leo Caddy project repository and converts a separate
destination repository. It is a dry-run unless `--apply` is supplied. Apply uses copied Git
objects (no hardlinks or alternates), preserves the source branch/history/remotes, and never
writes the legacy repository. A non-migration destination is never replaced.
Dry-run accepts the destination path for review but never creates it.

```bash
  bun run ops/migration/legacy-migrate.ts \
  --repository /home/caddy/caddy-projects-history \
  --destination-repository /home/caddy/project-registry-history \
  --software-projects /home/david/leo/software/data/projects \
  --software-owner leo \
  --dry-run
```

Apply the reviewed plan explicitly:

```bash
  bun run ops/migration/legacy-migrate.ts \
  --repository /home/caddy/caddy-projects-history \
  --destination-repository /home/caddy/project-registry-history \
  --software-projects /home/david/leo/software/data/projects \
  --software-owner leo \
  --apply
```

The importer keeps `projects/<owner>/<name>.json` paths, maps legacy Caddy fields
under `caddy`, merges matching Software metadata, and gives Software-only records
`caddy: null`. `shared` is removed because the current schema has no sharing state;
each conversion is reported. `template: true` is rejected. Invalid Software filename
stems must be mapped with a JSON object passed to `--name-mapping`, for example
`{"project_name":"project-name"}`.

Apply performs one schema-migration commit in the destination. A second apply validates the
matching completed migration and makes no changes.

## Offline Caddy candidate

Generate deterministic Caddy JSON from the migrated worktree without contacting the
Caddy admin API or changing live state:

```bash
  bun run ops/migration/caddy-candidate-generate.ts \
  --repository /home/caddy/project-registry-history \
  --output /tmp/project-registry-candidate.json
```

Without `--output`, the candidate is written to stdout. OIDC values are read from
`PROJECT_REGISTRY_OIDC_ISSUER`, `PROJECT_REGISTRY_OIDC_PROVIDER`,
`PROJECT_REGISTRY_OIDC_CLIENT_ID`, `PROJECT_REGISTRY_OIDC_CLIENT_SECRET`, and
`PROJECT_REGISTRY_OIDC_COOKIE_SECRET`; the existing `CADDY_PROJECTS_OIDC_*` names
are accepted as aliases.

## Semantic Caddy parity

Compare a legacy JSON baseline with a migrated candidate. Use `--repository` to generate the
migrated candidate offline with the task-3 generator, or pass an already generated candidate with
`--candidate`:

```bash
bun run ops/migration/caddy-semantic-parity.ts \
  --legacy /tmp/legacy-caddy.json \
  --repository /home/caddy/project-registry-history
```

The report normalizes JSON key/order differences, route order, hostname casing/trailing dots, and
the explicit legacy `127.0.0.1:2019` admin listener versus Caddy's equivalent default. It reports
actionable differences for listeners, every hostname, proxy upstreams/ports, static roots/paths,
headers, docs/browse/SPA behavior, access rules, and OIDC handlers. `--json` emits a deterministic
machine-readable report.

Validate the candidate with the production OIDC-capable Caddy binary without loading it or calling
the live admin API. Supplying `--caddy-bin` enables this validation; `--validate` makes that intent
explicit:

```bash
CADDY_USER="$(systemctl show caddy.service --property=User --value --no-pager)"
CADDY_GROUP="$(systemctl show caddy.service --property=Group --value --no-pager)"
bun run ops/migration/caddy-semantic-parity.ts \
  --legacy /tmp/legacy-caddy.json \
  --candidate /tmp/project-registry-candidate.json \
  --caddy-bin /home/caddy/.local/bin/caddy \
  --caddy-user "$CADDY_USER" \
  --caddy-group "$CADDY_GROUP" \
  --caddy-access-command /usr/sbin/runuser \
  --validate
```

Validation invokes only `caddy validate --config - --adapter ""` and sends the candidate on stdin. Preparation reads
the effective `User=` and `Group=` of the authoritative `caddy.service` (or an explicit offline identity fixture),
rejects missing/root identities and configured `CADDY_USER`/`CADDY_GROUP` mismatches, and passes both values to native
validation. The native Caddy process then runs with exactly the service user's UID/GID. `--caddy-access-command none`
is only for offline tests and must not be used for production preparation.

## Candidate dependency preflight (task 6)

Check a generated candidate before staging. The command only inspects host filesystem paths in
the JSON and connects to loopback proxy backends; it never probes public domains or calls Caddy:

```bash
CADDY_USER="$(systemctl show caddy.service --property=User --value --no-pager)"
CADDY_GROUP="$(systemctl show caddy.service --property=Group --value --no-pager)"
bun run ops/migration/caddy-dependency-preflight.ts \
  --candidate /tmp/project-registry-candidate.json \
  --caddy-user "$CADDY_USER" \
  --caddy-group "$CADDY_GROUP" \
  --caddy-working-directory /home/caddy \
  --caddy-access-command /usr/sbin/runuser
```

It checks every static/file root, browse `template_file`, and loopback `reverse_proxy` port.
Filesystem checks run read/traverse tests through the effective Caddy user and primary group. The default is the
explicit `/usr/sbin/runuser -u USER -g GROUP -- test ...` command form, and Leo preparation always passes
that command unless `CADDY_ACCESS_COMMAND` or `--caddy-access-command` overrides it. A missing
requested command, failed identity probe, invalid identity output, or identity mismatch fails
dependency preflight clearly; it never silently falls back to mode-bit checks. Use
`--caddy-access-command PATH` only for a reviewed compatible command. The ACL-blind
permission-bit fallback is available only with the explicit
`--caddy-access-command none` test/offline option. Filesystem checks still require Caddy-readable
files/directories and traversable parent directories.
Relative browse templates are resolved from `--caddy-working-directory` (the current directory
by default). `--allow-missing-backends` reports stopped loopback backends as warnings, while
`--allow-missing-filesystem` reports missing or inaccessible filesystem paths as warnings. Both
options are explicit; strict behavior remains the default. Failures and warnings are aggregated
and deterministic; a passing command prints `dependency preflight: PASS`. Access-runner
availability and identity failures remain fatal in either mode.

## Production daemon staging

`install-project-registryd.bash` is preparation-only. It builds the actual daemon
with `bun run build:lib`, installs the unbundled `dist/daemon.js` runtime and its
dependencies, stages an explicit verified Bun executable at the stable,
root-owned `/usr/local/bin/project-registry-bun` path, writes the production environment and unit templates, and
normalizes the existing Leo OIDC environment without putting its values in this repository.
The defaults are the migrated repository `/home/caddy/project-registry-history`,
loopback `127.0.0.1:8080`, Caddy admin `http://127.0.0.1:2019`, HTTPS listener
`:443`, project ports `3000-3999`, and Caddy `/home/caddy/.local/bin/caddy`.
Access-log storage is intentionally unset by default; production must explicitly set
`PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT`.

Preview the exact files without changing the host:

```bash
BUN_BIN=/home/david/.bun/bin/bun \
  bash ops/migration/install-project-registryd.bash --dry-run
```

After reviewing the output, stage/install the files as root:

```bash
sudo env BUN_BIN=/home/david/.bun/bin/bun \
  PROJECT_REGISTRY_SOURCE=/home/david/adaptive/project-registry \
  bash ops/migration/install-project-registryd.bash --apply
```

The installer is idempotent: the Bun destination and its containing directory are
reset to `root:root` and mode `0755` on every apply, including when `BUN_BIN` is
already the destination. This prevents `caddy` or another service account from
replacing the executable. It performs no service start, enable, stop, restart,
reload, or systemd daemon reload. It installs the normalized OIDC file as root-owned
mode `0600`, the non-secret environment as `0640`, and the unit as `0644`. The
unit separately references the required root-owned `0600` `/etc/project-registry/zitadel.env`;
provision that file from a secret store or pass it with `PROJECT_REGISTRY_ZITADEL_SOURCE`.
The OIDC file supplies the session cookie credential, while session limits remain in the
non-secret environment. Do not
activate the unit during task 5; service activation belongs to the later cutover
procedure. A safe syntax check after staging is:

```bash
systemd-analyze verify /etc/systemd/system/project-registryd.service
systemd-analyze verify /etc/systemd/system/caddy.service
systemctl show caddy.service --property=User --property=Group --no-pager
CADDY_USER="$(systemctl show caddy.service --property=User --value --no-pager)"
CADDY_GROUP="$(systemctl show caddy.service --property=Group --value --no-pager)"
runuser -u "$CADDY_USER" -g "$CADDY_GROUP" -- id -u
```

### Optional Caddy access-log storage

Access logging is disabled when `PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT` is unset. Enable it only in a reviewed
production environment, for example:

```bash
sudo env \
  PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT=/var/lib/project-registry/caddy-access-logs \
  PROJECT_REGISTRY_ZITADEL_SOURCE=/run/secrets/project-registry-zitadel.env \
  BUN_BIN=/home/david/.bun/bin/bun \
  PROJECT_REGISTRY_SOURCE=/home/david/adaptive/project-registry \
  bash ops/migration/install-project-registryd.bash --apply
```

The root is deliberately outside the migrated Git repository. The installer creates `root`, `root/projects`, and
`root/quarantine` owned by the exact effective `User=`/`Group=` of the authoritative `caddy.service`, with mode `0700`.
Caddy creates each project directory and `access.jsonl`; the generated JSON explicitly sets the native file writer's
`mode: "0600"` and `dir_mode: "0700"`, so this uses the production-compatible Caddy file-writer fields rather than
relying on an ambient umask. Caddy rotation files are `0600` regular files, and retention metadata and its bounded
temporary names are root-owned regular `0600` files. The installer provisions only the three base directories; it does
not enumerate, audit, or repair existing project files, archives, or metadata. The root daemon reads the Caddy-owned
log files as root and writes its own metadata with the same `0600` mode. Preparation checks that the already-provisioned
directories are readable, traversable, and writable by the effective Caddy user. No custom Caddy service drop-in is
installed or migrated; the explicit Caddy file-writer `mode: "0600"` and `dir_mode: "0700"` settings remain authoritative.

Capacity is bounded per active project by Caddy's 25 MiB size roll, daily roll, gzip compression, seven-day retention,
and eight-archive limit: plan for up to 225 MiB before compression for the active file plus eight archives. Multiply
that by the number of active projects and leave additional disk for recently inactive project directories. The daemon
marks inactive directories, retains them for seven days, atomically moves expired ones to `quarantine`, and defers
quarantine cleanup for 24 hours. Quarantine is not Git storage and is cleaned only after its metadata and files pass
the no-follow checks. Monitor the filesystem; there is no global byte quota.

#### Enable, disable, and rollback

1. **Enable:** provision the Zitadel env file with mode `0600`, set the log-root variable, run the installer, inspect
   the staged files, run `systemd-analyze verify`, and check `stat` ownership/modes for the three directories. If
   using `prepare-leo.bash`, provision the hierarchy before its `--apply` validation pass. Run native validation as
   `$CADDY_USER` before any cutover.
2. **Disable:** unset `PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT` and re-stage the daemon. The generated Caddy config
   then has no access-log writers. Keep old logs outside Git until the retention/rollback window is closed; do not
   delete them as part of installation.
3. **Rollback:** use the reviewed migration rollback procedure. Stop only the replacement daemon, restore the saved
   Caddy JSON, and resume the retained daemon. Logging data is not copied into Git or deleted by rollback; restore the
   previously reviewed log-root setting only if the replacement configuration is resumed.

Installation checks must be read-only after staging: `systemd-analyze verify`, `stat -c '%U:%G %a %n'` for the log
hierarchy, `systemctl show caddy.service --property=User --property=Group`, `runuser -u USER -g GROUP -- id -u`, and
native stdin validation. The installer and preparation scripts never start, enable, stop, restart, reload, or
daemon-reload a service.

## Leo preparation (task 6)

`prepare-leo.bash` is the repeatable, preparation-only command. It defaults to
dry-run and requires `--apply` for writes. Every Leo source and destination is
an option; there are no implicit host paths. On apply, it captures the running
Caddy JSON with a GET of the loopback `/config/` endpoint. Pass
`--legacy-caddy-config PATH` only to override that live baseline for offline
testing.

The established `/home/caddy/.local/share/caddy` tree is authoritative. Preparation
does not copy certificate data from a legacy Caddy data directory or modify the live Caddy data tree,
`caddy.json`, or the authoritative Caddy unit. On `--apply`, it captures and validates the
 baseline, migrates and generates the candidate, then completes semantic parity,
the dependency preflight (with existing missing filesystem paths and stopped development backends
warned), and stdin-only Caddy validation before creating the backup or any install/stage
files. A passing run creates a new backup under the requested backup root as
`caddy-state-YYYYMMDDTHHMMSSZ[-N]`, including `caddy-admin-config.json`, then
stages the candidate JSON and unchanged unit at separate paths. The live files remain unchanged.

Preview the complete plan while the old stack remains live:

```bash
bash ops/migration/prepare-leo.bash --dry-run \
  --project-registry-source /home/david/adaptive/project-registry \
  --legacy-repository /home/caddy/caddy-projects-history \
  --migrated-repository /home/caddy/project-registry-history \
  --software-projects /home/david/leo/software/data/projects --software-owner leo \
  --candidate-output /tmp/project-registry-candidate.json \
  --caddy-admin-url http://127.0.0.1:2019/config/ \
  --oidc-source /home/david/leo/leo-server/caddy/oidc/leonardomora.oidc.env \
  --caddy-data-destination /home/caddy/.local/share/caddy \
  --caddy-backup-root /home/caddy/project-registry-caddy-backups \
  --caddy-binary-source /home/caddy/.local/bin/caddy \
  --caddy-binary-destination /home/caddy/.local/bin/caddy \
  --caddy-unit-source /home/david/leo/leo-server/caddy/service/caddy.service \
  --caddy-unit-destination /etc/systemd/system/caddy.service \
  --caddy-config-destination /home/caddy/.config/caddy/caddy.json \
  --caddy-config-stage /home/caddy/project-registry-caddy-staging/caddy.json \
  --caddy-unit-stage /home/caddy/project-registry-caddy-staging/caddy.service \
  --caddy-oidc-destination /home/caddy/.config/caddy/leonardomora.oidc.env \
  --caddy-oidc-alias-destination /home/caddy/.config/caddy/caddy-projects.oidc.env \
  --project-registry-install-root /home/caddy/project-registry \
  --project-registry-config-root /etc/project-registry \
  --project-registry-unit-destination /etc/systemd/system/project-registryd.service
```

After reviewing the plan, use the same command with `--apply` (and
`--name-mapping PATH` when the Software filenames need mapping). Apply first
captures the live admin JSON, then checks parity, candidate dependencies (warning on already-unavailable
filesystem paths and stopped backends), and candidate validation before it
backs up the existing Caddy data, live JSON, and live unit under a new
timestamped/non-colliding directory. It does not copy or normalize TLS data.
It runs task 1, task 3, task 4, and the task-6 dependency preflight first. After they pass, it stages the
  OIDC-capable Caddy binary, candidate config, unchanged candidate unit, task-5 daemon artifacts/unit, and the existing
  OIDC env. A migration marker makes repeat apply
runs skip task 1 while each run retains another backup and stages only the
separate candidate paths.

Preparation never starts, stops, enables, restarts, reloads, or daemon-reloads
services, loads a config through the Caddy admin API, or runs Caddy as a server. It
performs only the read-only `/config/` capture. Task-4
validation uses `caddy validate --config - --adapter ""` with the candidate on
stdin, so ports 80/443 are not bound. Cutover, rollback, and live-host apply
execution are deliberately outside this command.

## Migration wrapper (task 7)

`migrate-leo.bash` is the single wrapper for the three migration actions. Every
action defaults to a dry-run; only `--apply` can change files through `prepare`
or control services through `cutover`/`rollback`.

Preview preparation through the wrapper (all preparation options are passed to
`prepare-leo.bash`):

```bash
bash ops/migration/migrate-leo.bash prepare --dry-run \
  --project-registry-source /home/david/adaptive/project-registry \
  --legacy-repository /home/caddy/caddy-projects-history \
  --migrated-repository /home/caddy/project-registry-history \
  --software-projects /home/david/leo/software/data/projects --software-owner leo \
  --candidate-output /tmp/project-registry-candidate.json \
  --caddy-admin-url http://127.0.0.1:2019/config/ \
  --oidc-source /home/david/leo/leo-server/caddy/oidc/leonardomora.oidc.env \
  --caddy-data-destination /home/caddy/.local/share/caddy \
  --caddy-backup-root /home/caddy/project-registry-caddy-backups \
  --caddy-binary-source /home/caddy/.local/bin/caddy \
  --caddy-binary-destination /home/caddy/.local/bin/caddy \
  --caddy-unit-source /home/david/leo/leo-server/caddy/service/caddy.service \
  --caddy-unit-destination /etc/systemd/system/caddy.service \
  --caddy-config-destination /home/caddy/.config/caddy/caddy.json \
  --caddy-config-stage /home/caddy/project-registry-caddy-staging/caddy.json \
  --caddy-unit-stage /home/caddy/project-registry-caddy-staging/caddy.service \
  --caddy-oidc-destination /home/caddy/.config/caddy/leonardomora.oidc.env \
  --caddy-oidc-alias-destination /home/caddy/.config/caddy/caddy-projects.oidc.env \
  --project-registry-install-root /home/caddy/project-registry \
  --project-registry-config-root /etc/project-registry \
  --project-registry-unit-destination /etc/systemd/system/project-registryd.service
```

After reviewing it, repeat with `--apply`. Preparation remains responsible for
staging files and does not activate services.

Preview the service switch. Rollback requires the exact reviewed backup JSON (or
its `caddy-state-*` directory), plus the explicit live Caddy paths:

```bash
bash ops/migration/migrate-leo.bash cutover
bash ops/migration/migrate-leo.bash rollback \
  --caddy-binary /home/caddy/.local/bin/caddy \
  --caddy-config /home/caddy/.config/caddy/caddy.json \
  --caddy-backup /home/caddy/project-registry-caddy-backups/caddy-state-YYYYMMDDTHHMMSSZ
```

On Leo, run the reviewed switch as root with `--apply`:

```bash
sudo bash ops/migration/migrate-leo.bash cutover --apply
sudo bash ops/migration/migrate-leo.bash rollback --apply \
  --caddy-binary /home/caddy/.local/bin/caddy \
  --caddy-config /home/caddy/.config/caddy/caddy.json \
  --caddy-backup /home/caddy/project-registry-caddy-backups/caddy-state-YYYYMMDDTHHMMSSZ
```

Before either a dry-run plan or an apply, the wrapper runs read-only systemd
unit preflights for `caddy-projects.service` and `project-registryd.service`.
All preflights complete before any service mutation; a failed preflight leaves
both daemons untouched. The public, authoritative system `caddy.service` stays
running throughout and is never passed to `systemctl` by this wrapper. There is no
user-manager Caddy path.

Cutover uses this fixed order: stop and disable `caddy-projects.service`, reload
systemd, then enable and start `project-registryd.service` in the system
manager. Rollback performs this fixed order: stop and disable
`project-registryd.service`, reload the saved JSON into the already-running
system `caddy.service` with the configured Caddy binary/admin URL, persist it at
the configured Caddy JSON path, reload systemd, then enable and start the
retained `caddy-projects.service`. The daemon unit names can be overridden with
`--old-projects-service` and `--new-daemon-service` for a reviewed host; there
are no old/new Caddy service options.

Rollback validates `caddy-admin-config.json` offline with
`caddy validate --config caddy-admin-config.json --adapter ""` before stopping
either daemon. The empty adapter selects Caddy's native JSON interface; `json`
is not a production adapter name. A failed validation or reload exits non-zero, does not
start the retained daemon, and never claims a completed rollback. The public
`caddy.service` is never stopped, restarted, or passed to `systemctl`; Caddy's
admin API reload is the only live Caddy operation. Dry-run performs the same
read-only offline validation, but never reloads Caddy, writes the config file, or
changes either daemon.

## Disposable staging access-log check (task 9)

Run `ops/staging/caddy-project-access-logs-check.bash` only against a fresh,
disposable staging deployment. It sends credentials and query secrets into the
raw access logs, so do not use production credentials, hosts, projects, sockets,
or log roots. The check does not deploy or clean up the target.

### Prerequisites and validation

The staging deployment must provide an active, non-root `caddy.service`, an
HTTP `project-registryd` endpoint, two owner-bound Unix sockets, the deployed
CLI, and a fresh access-log root outside Git. The root and its `projects` and
`quarantine` directories must already be mode `0700` and owned by the effective
Caddy `User=`/`Group=`. The two project log directories must have no data or
rotated archives (an empty active `access.jsonl` is acceptable). Prepare two
distinct owners, project names, and Caddy hosts;
each host must serve the safe GET `--request-path`.

First run the non-contacting prerequisite check:

```bash
bash ops/staging/caddy-project-access-logs-check.bash --validate
```

`--validate` checks only local commands. It does not contact a target, read the
credential header files, or change the staging deployment.

`--run` has no defaults. All of these options are required exactly once:

```text
--api-url URL --caddy-url URL
--api-headers-a FILE --api-headers-b FILE
--unix-socket-a PATH --unix-socket-b PATH --cli PATH --log-root PATH
--staging-attestation FILE
--owner-a USER --owner-b USER --project-a NAME --project-b NAME
--host-a HOST --host-b HOST --request-path PATH --rotation-count N
```

The header files must be regular, non-symlink, readable files with no
group/other permission bits and must contain a `Cookie:` header. Paths are
absolute; URLs are `http://` or `https://`. Each owner, project, and host A/B
pair must be distinct, and `--rotation-count` must be `1` through `100000`.
Before any target activity, `--cli` must name a non-symlink regular executable
owned by root with no group/other write bits. Every parent directory through
`/` must also be non-symlink, root-owned, and have no group/other write bits.
Append `--insecure` only for an explicitly supplied disposable staging
certificate mismatch.

### Deployment attestation and invocation

The deployment process must create `--staging-attestation` before `--run`; the
check never creates or updates it. As root, create a temporary file and
atomically rename it into place with owner `root:root` and mode `0600`. Its only
bytes are these four newline-terminated lines:

```text
version=1
purpose=caddy-project-access-logs-staging
deployment_id=<32 lowercase hexadecimal characters>
target_sha256=<64 lowercase hexadecimal characters>
```

Generate the deployment ID as 16 random bytes rendered by
`od -An -N16 -tx1 /dev/urandom | tr -d ' \n'`. The digest is the SHA-256 of
the NUL-separated values, in this exact order: normalized `--api-url` (one
trailing slash removed), normalized `--caddy-url`, the two header *file paths*,
the two socket paths, CLI path, log-root path, attestation path, deployment ID,
the two owners, the two projects, the two hosts, request path, rotation count,
and TLS mode (`0`, or `1` when `--insecure` is supplied). The deployment must
hash paths and settings only; it must never read or put credential contents in
the digest, command output, attestation, or process arguments.

For example, with variables set to the exact invocation values, the root-only
deployment step is:

```bash
api_url="${API_URL%/}"
caddy_url="${CADDY_URL%/}"
tls_mode=0 # use 1 only when --insecure is passed
deployment_id="$(od -An -N16 -tx1 /dev/urandom | tr -d ' \n')"
target_sha256="$(
  printf '%s\0' \
    "$api_url" "$caddy_url" "$API_HEADERS_A" "$API_HEADERS_B" \
    "$UNIX_SOCKET_A" "$UNIX_SOCKET_B" "$CLI" "$LOG_ROOT" \
    "$STAGING_ATTESTATION" "$deployment_id" "$OWNER_A" "$OWNER_B" \
    "$PROJECT_A" "$PROJECT_B" "$HOST_A" "$HOST_B" "$REQUEST_PATH" \
    "$ROTATION_COUNT" "$tls_mode" |
    sha256sum | awk '{ print $1 }'
  )"
umask 077
attestation_tmp="$(mktemp "${STAGING_ATTESTATION}.tmp.XXXXXX")"
printf 'version=1\npurpose=caddy-project-access-logs-staging\ndeployment_id=%s\ntarget_sha256=%s\n' \
  "$deployment_id" "$target_sha256" >"$attestation_tmp"
chown root:root -- "$attestation_tmp"
chmod 600 -- "$attestation_tmp"
mv -- "$attestation_tmp" "$STAGING_ATTESTATION"
```

Only file names and non-secret target values enter this command; the header
files are never opened by the attestation step.

The invocation must pass the same values used for the attestation:

```bash
sudo bash ops/staging/caddy-project-access-logs-check.bash --run \
  --api-url "$API_URL" \
  --caddy-url "$CADDY_URL" \
  --api-headers-a "$API_HEADERS_A" \
  --api-headers-b "$API_HEADERS_B" \
  --unix-socket-a "$UNIX_SOCKET_A" \
  --unix-socket-b "$UNIX_SOCKET_B" \
  --cli "$CLI" \
  --log-root "$LOG_ROOT" \
  --staging-attestation "$STAGING_ATTESTATION" \
  --owner-a "$OWNER_A" --owner-b "$OWNER_B" \
  --project-a "$PROJECT_A" --project-b "$PROJECT_B" \
  --host-a "$HOST_A" --host-b "$HOST_B" \
  --request-path "$REQUEST_PATH" \
  --rotation-count "$ROTATION_COUNT"
```

Add `--insecure` only when it was included as TLS mode `1` in the attestation.

The check proves complete raw-record preservation of query, Cookie, and
Authorization values; project/host logger isolation; Caddy-owned `0700`/
`0600` permissions, archive and retention-metadata permissions; filesystem,
HTTP, and both explicit and owner-inferred Unix reads returning identical
records; cross-owner HTTP/Unix `404` authorization parity; one-roll rotation
continuity; and bounded page, filesystem-read, decompression, record, line, and
disk behavior. Production planning capacity is approximately `225 MiB` per
project (25 MiB for the active file plus eight 25 MiB archives, before
compression). Separately, the staging check allows and enforces its explicit
`226 MiB` apparent-size ceiling per project: `25 MiB × 9 + 1 MiB` observation
slack. It sends only GETs, with two initial requests, one pre-rotation request,
at most `--rotation-count` rotation requests (batches of at most eight parallel
requests), and one post-rotation request. `--rotation-count` is a maximum
traffic budget, not a guaranteed count: a passing run must observe rotation,
and an insufficient count fails when rotation is not observed. Adjust that
count only on disposable staging, never on production or a reused target. The
script bounds each project at the explicit `226 MiB` ceiling, pages at
`8 MiB`/`1000` records, and filesystem reads at `64 MiB` scanned/decompressed,
`128 KiB` per line, and `1000000` records. Temporary response/work files are
mode `0600` and are removed by the script's exit trap.

After the run, destroy the disposable services and remove both test projects,
their access-log root, the two header files, sockets, CLI staging files, and
the attestation. The script removes only its temporary workspace; it does not
delete target logs. Never run this check against production or any
non-disposable/reused target.
