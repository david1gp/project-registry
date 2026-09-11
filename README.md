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
- `bun run release` version, changelog, GitHub release

## License

MIT
