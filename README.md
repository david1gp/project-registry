# @adaptive-ds/project-registry

A project model for the machine-wide Adaptive Project Registry.

Package name follows the rest of the stack: `@adaptive-ds/` plus the folder name.

## Install

```bash
bun add @adaptive-ds/project-registry
```

## Usage

```typescript
import { projectList, projectNormalize } from "@adaptive-ds/project-registry"

const normalized = projectNormalize({
  owner: "david",
  name: "project-registry",
  description: "Adaptive project catalog",
})
if (!normalized.success) return normalized

console.log(projectList([normalized.data]).data.map((project) => project.name))
```

Project identity is the `(owner, name)` pair. Normalization validates the combined registry and Caddy model, and listing applies deterministic Software-compatible ordering. Fallible operations return a `Result` from `@adaptive-ds/result`.

## Preview vs dev servers

The `*.wonder1.de` preview serves a production build through a registry-managed
system unit (`proj-<project>-<service>.service`): `bun run preview:start` with the
service env file `.env.preview` (projects not yet migrated still run their dev
script). Refresh it with `bun run preview:deploy`, which
restarts the unit via `project-registry svc restart`:

```bash
project-registry svc restart <project> --service <service>
```

Dev servers are separate: `project-registry dev up <project>` leases its own port
and domain (`<user>-<project>.wonder1.de`), runs the package.json `dev` script with
`PORT`/`HOST` set, and reads `.env.development` — never the preview port or
`.env.preview`. Never run `bun run dev` on the preview port by hand.

### Rootless container services

A managed service can run a rootless Podman container as the service user
(`projects`) instead of a bun process. The row command is the `podman run …`
invocation (`{port}` is the registry port); the unit adds `--rm --replace
--name proj-<project>-<service>`, readiness (`--sdnotify=conmon`), a delegated
cgroup, journal logging, and an explicit `podman stop`/`rm`:

```bash
project-registry project edit <project> --owner shared --service default \
  --service-container podman \
  --service-command "podman run --publish 127.0.0.1:{port}:8080 --volume /projects/<project>/data:/data:Z localhost/<image>@sha256:<digest> <args>" \
  --autostart
```

Container units keep `ProtectSystem=strict`, `ProtectHome=tmpfs`,
`PrivateTmp=yes` and `/servers` hidden, but drop `NoNewPrivileges` (setuid
`newuidmap` must write the user namespace maps) and bind the user's
`/run/user/<uid>` (`XDG_RUNTIME_DIR`). The service user needs subuid/subgid
ranges and lingering. Images live in its store
(`/home/projects/.local/share/containers/storage`, runroot
`/run/user/<uid>/containers`); load or build them there as that user. `svc
start|stop|restart|logs` work like for every other managed service. See
`docs/20261121_container_services.md`.

## Asynchronous history backup

With `PROJECT_REGISTRY_GIT_PUSH=true`, daemon mutations commit locally and return
`push: { requested: true, status: "queued" }`. Remote Git latency or failure does not
block CLI/API mutations. One background worker per repository pushes the latest
committed HEAD to the configured branch's upstream (no force push or rebase),
coalescing commits received during a push into one follow-up push.

Failures remain visible in `project-registry status` (including a `WARNING` line)
and `project-registry status --json`, under `data.historyPush` in the existing
`GET /api/v1/caddy/status` response. Fields include pending/in-flight state,
last attempt/success times (epoch milliseconds), last pushed revision, last error,
consecutive failure count, and the last observed local ahead count (`null` when
unknown). This is in-memory operational state, not a durable audit log.

Failed pushes retry after 30 seconds, 2 minutes, then 10 minutes (capped); a new
commit triggers an immediate retry. Startup checks the local upstream-tracking
ref for unpushed commits to catch up after a restart. This check does not fetch
or contact the remote. Errors are also logged through the daemon logger:

```bash
sudo journalctl -u project-registryd.service --since '30 minutes ago' --no-pager | grep 'history push'
```

The worker captures an immutable committed SHA under the mutation lock, then
releases the lock before all push/verification network I/O. Push updates remote
tracking refs atomically and does not touch the worktree or index. Shutdown
cancels future retries without waiting for network I/O; startup recovers any
remaining local commits. Direct, short-lived library consumers keep synchronous
`autoPush: true` unless they explicitly opt into `asyncPush: true` and own the
returned repository's `historyPush.start(logger)` / `stop()` lifecycle. Offline
migration defaults to no push, unchanged.

## Default user domains

Each owner can persist a default base domain in the Git-backed registry with the CLI:

```bash
project-registry user default-domain get
project-registry user default-domain set example.com
project-registry user default-domain unset
```

`set` is an upsert. `unset` persists an explicit unset decision, so it suppresses the environment fallback for that owner. Project defaults resolve in this order: explicit project domains, the persisted user decision, the environment fallback, and then no domain.

Repositories without a stored user decision can use the environment fallback, configured as JSON in `PROJECT_REGISTRY_DEFAULT_USER_DOMAINS`:

```bash
PROJECT_REGISTRY_DEFAULT_USER_DOMAINS='{"leo":"leonardomora.de"}'
```

Creating project `api` for `leo` without `--domain` assigns `api.leonardomora.de`. Explicit domains continue to override the configured default. The API equivalents are:

```text
GET    /api/v1/users/:owner/default-domain
PUT    /api/v1/users/:owner/default-domain
DELETE /api/v1/users/:owner/default-domain
```

`PUT` accepts `{ "expectedRevision": "...", "domain": "example.com" }`; `DELETE` accepts `{ "expectedRevision": "..." }`.
The `GET` response reports the effective `domain`, its `source` (`explicit`, `environment`, or `none`), and the registry `revision`. JSON CLI output preserves the complete response or mutation data, including the revision.

## Managed docs publishers

The daemon optionally accepts `PROJECT_REGISTRY_DOCS_PUBLISHERS` as a JSON object mapping owners to usernames allowed to publish managed docs for them:

```bash
PROJECT_REGISTRY_DOCS_PUBLISHERS='{"leo":["david"]}'
```

This grants only docs publication, not access to the owner's other API endpoints. An unset or empty value grants no additional access.

## Project static ACL repair

Repair Caddy's filesystem access for all static service roots in a project with the authenticated daemon API:

```bash
project-registry project fix-acl <name>
```

The CLI reports each repaired root and entry count. If Caddy runs as root, repair is unnecessary and the CLI says so;
the daemon does not inspect or modify the filesystem in that mode. Non-root repair currently supports the `caddy`
identity; another configured non-root identity fails explicitly before filesystem access. The daemon authorizes the
project owner and derives filesystem roots from its canonical static services; the CLI accepts no filesystem paths.
Use `--json` for the structured per-root results. API errors (including projects without static services and individual
ACL failures) are returned with their actionable message and optional hint.

## Publishing documentation

`docs <path>` always reads a local Markdown file (relative paths are resolved from the current directory) and publishes it to the authenticated owner's documentation space. It does not inspect the current directory's project registration or docs settings:

```bash
project-registry docs README.md
```

Relative input paths that resolve within the current working directory become normalized logical page paths and preserve their hierarchy (`./guide/intro.md` publishes as `guide/intro.md`, and `docs/../guide.md` as `guide.md`). A leading `docs/` segment is stripped, so `docs/guide.md` publishes as `guide.md` and serves at `/docs/guide.md` instead of `/docs/docs/guide.md`. Absolute inputs and relative inputs that resolve outside the current directory publish under their basename, so `../guide.md` publishes as `guide.md`. Logical paths accept only route-safe ASCII letters, digits, dots, underscores, hyphens, and `/`; source paths may contain `..`, but the generated logical path never traverses. Publishing the same logical path again updates that page for the owner, even when the source file is elsewhere. The generated `index.md` is reserved and cannot be published as a page. The CLI prints the published document URL and index URL.

Use `project-registry docs <name> <path>` for explicit legacy project-hosted URL lookup. This two-argument form remains separate from local publication and honors `--http` as before.

## Cloudflare DNS credentials

When the daemon's Cloudflare DNS integration is enabled, it reads the credential for each project owner from:

```text
/etc/project-registry/cloudflare/{owner}.env
```

Set `PROJECT_REGISTRY_CLOUDFLARE_CREDENTIALS_DIR` to use another absolute directory. Each file may contain
`CLOUDFLARE_API_TOKEN=value` or the `CF_API_TOKEN=value` alias; the preferred name wins. Files are parsed as simple
assignments and are never executed or sourced. A missing owner file defers that owner's DNS work for retry, and a
global `CLOUDFLARE_API_TOKEN` or `CF_API_TOKEN` environment variable is not used as a fallback.

Set `PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED=false` to disable DNS reconciliation explicitly. The default is enabled,
but no DNS request is made until the relevant owner's credential is available.

DNS reconciliation only reads zones and manages DNS records. Owner tokens need Zone Read and DNS Edit access for
the intended zones; Zone Settings and Zaraz permissions are not required. Reconciliation no longer changes email
obfuscation or Zaraz configuration. Configure those unrelated zone settings separately if needed.

### DNS health and diagnostics

Project creation, editing, and deletion save the registry first and reconcile DNS asynchronously. A successful
mutation means the registry was saved, not that Cloudflare accepted the DNS changes. Check both Caddy and DNS with:

```bash
project-registry status
project-registry status --json
```

Status includes DNS queue counts and current failures or deferrals, including unavailable owner credentials, pending
server-IP discovery, tracking failures, and Cloudflare errors. JSON adds a `cloudflareDns` field to the existing Caddy
status data. Queue counts are daemon-wide; project/record diagnostics are scoped to the authenticated owner, while
global tracking failures remain visible. Older daemons that omit DNS status must not be interpreted as reporting healthy
DNS. DNS status is in-memory operational state; it is rebuilt on restart rather than being a durable audit history.

On an edit, the daemon reconciles and durably tracks all replacement public records before deleting the project's
obsolete tracked records. Failed or partial replacement creation retains the old records for retry, including after a
restart. A project deletion or removal of all public domains can still retire records without needing a server IP.
Only previously tracked records are eligible for verified deletion; external services and `pages.dev` remain protected.

Daemon logs use the `cloudflare DNS` prefix and include structured operation/outcome and project/hostname context,
with retry information and HTTP status/Cloudflare numeric error codes when available. Success/recovery transitions
are logged without repeating unchanged DNS successes every scan. Logs and status never include tokens, authorization
headers, raw Cloudflare response bodies/messages, or credential-file contents. With administrator log access:

```bash
sudo journalctl -u project-registryd.service --since '30 minutes ago' --no-pager \\
  | grep 'cloudflare DNS'
```

For authentication/permission failures, update the affected owner's token and verify its zone scope. For rate limits
or temporary Cloudflare failures, inspect the retry information rather than repeatedly editing the registry. A failed
tracking read/write requires fixing the daemon's tracking storage before safe reconciliation can resume.

### Updating an owner token

The supported user workflow reads the token from stdin, so the secret is not placed in process arguments or shell
history:

```bash
secret-manager cloudflare-token | project-registry user cloudflare-token set --token-stdin
```

Use `--json` for the safe response envelope or `--socket <path>` to select a daemon socket. Human output is
`updated cloudflare-token`; JSON output is `{ "success": true, "data": { "updated": true } }`.

The authenticated API operation is:

```text
PUT /api/v1/users/{owner}/cloudflare-token
{ "token": "<token supplied in the request body>" }
```

It returns `{ "success": true, "data": { "updated": true } }`. There is no token get/list endpoint. The owner is
bound to the authenticated CLI socket user or HTTP session; a request cannot update another owner.

The library exports the privileged daemon-side filesystem component, not a general user credential client:

```typescript
import {
  projectRegistryDaemonCloudflareCredentialsCreate,
  projectRegistryDaemonCloudflareCredentialsFilesystemDefault,
} from "@adaptive-ds/project-registry"

const credentialsR = projectRegistryDaemonCloudflareCredentialsCreate({
  directory: "/etc/project-registry/cloudflare",
  filesystem: projectRegistryDaemonCloudflareCredentialsFilesystemDefault(),
})
if (!credentialsR.success) return credentialsR
const updatedR = await credentialsR.data.tokenSet(owner, token)
```

Only the privileged daemon should construct this factory and call `tokenSet`; normal users should use the authenticated
CLI or API. Updating a token does not immediately reconcile DNS. The next DNS operation reads the updated owner file.

## Scripts

- `bun run dev` watch tests
- `bun run test` run tests once
- `bun run build` emit `dist/`
- `bun run format` biome format
- `bun run release` version, changelog, GitHub release, then deploy (the release commit, so the daemon serves the released tree; `--no-deploy` skips)
- `bun run deploy` deploy the working tree without releasing

## License

MIT
