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

## Scripts

- `bun run dev` watch tests
- `bun run test` run tests once
- `bun run build` emit `dist/`
- `bun run format` biome format
- `bun run release` version, changelog, GitHub release

## License

MIT
