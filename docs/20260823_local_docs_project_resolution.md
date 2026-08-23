# Local docs project resolution

## Goal

Restore the migrated `caddy-projects` behavior where `project-registry docs <path>` resolves the registered project from the current working directory, while preserving `project-registry docs <name> <path>`.

## Decisions

- Accept one or two positional arguments for `docs`.
- Resolve the one-argument form against registered project paths using exact or descendant matching.
- Prefer the longest matching registered path for nested projects.
- Keep explicit project-name behavior unchanged.

## Approach

- Represent the local-directory docs invocation explicitly in CLI types and parsing.
- Add a focused, path-boundary-safe project resolver.
- Resolve the project before making the existing docs request.
- Update CLI help and automated tests.

## Tasks

- [x] 1. Add invocation parsing and help support for `docs <path>`.
- [x] 2. Add and test current-directory project resolution.
- [x] 3. Integrate local resolution into docs command execution and test both forms.
- [x] 4. Run focused and full verification.

## Paths

- `src/cli/ProjectRegistryCliInvocation.ts`
- `src/cli/projectRegistryCliArgumentsParse.ts`
- `src/cli/projectRegistryCliArgumentsParse.test.ts`
- `src/cli/projectRegistryCliHelp.ts`
- `src/cli/projectRegistryCliOutputFormat.ts`
- `src/cli/projectRegistryCliRun.ts`
- `src/cli/projectRegistryCliRun.test.ts`
- `src/cli/projectNameFromPath.ts`
- `src/cli/projectNameFromPath.test.ts`
