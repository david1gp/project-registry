# @adaptive-ds/project-registry

A small in-memory catalog of Adaptive projects. You hand it a folder name, it stores a record, and you can list or look one up without walking the filesystem again.

Package name follows the rest of the stack: `@adaptive-ds/` plus the folder name.

## Install

```bash
bun add @adaptive-ds/project-registry
```

## Usage

```typescript
import { projectRegister, projectGet, projectList } from "@adaptive-ds/project-registry"

const created = projectRegister({
  name: "project-registry",
  description: "In-memory Adaptive project catalog",
})
if (!created.success) return created

const found = projectGet("project-registry")
if (!found.success) return found

console.log(found.data.name)
console.log(projectList().data.map((p) => p.name))
```

`projectRegister` fails if the name is empty or already taken. `projectGet` fails if the id is missing. Both return a `Result` from `@adaptive-ds/result`.

## Scripts

- `bun run dev` watch tests
- `bun run test` run tests once
- `bun run build` emit `dist/`
- `bun run format` biome format
- `bun run release` version, changelog, GitHub release

## License

MIT
