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

## Scripts

- `bun run dev` watch tests
- `bun run test` run tests once
- `bun run build` emit `dist/`
- `bun run format` biome format
- `bun run release` version, changelog, GitHub release

## License

MIT
