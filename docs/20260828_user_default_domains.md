# User default domains

## Goal

Allow each project owner to read, set, update, and unset a persistent default base domain through the API and CLI, while preserving existing environment-configured behavior for repositories without a stored user decision.

## Decisions

- Add `project-registry user default-domain get|set <domain>|unset`; `set` is an upsert, so there is no separate update command.
- Add owner-scoped `GET`, `PUT`, and `DELETE /api/v1/users/:owner/default-domain` routes using existing owner authorization.
- Store per-user decisions in the Git-backed registry repository and reuse its revision, serialization, recovery, and commit conventions.
- Resolve project defaults in this order: explicit project domain, persisted user decision, environment fallback, no default.
- Persist an explicit unset decision so legacy environment fallback does not silently restore a domain after `unset`; repositories with no stored decision continue using the environment map.
- Normalize and validate persisted values with the existing default-domain rules.
- Existing projects remain unchanged when a user default changes.

## Approach

- Extend the repository with a narrowly scoped user-default-domain model and operations.
- Expose the effective setting and its source through the API, and use the same resolution during project creation.
- Add typed CLI invocations, parser/help coverage, request dispatch, and human/JSON output.
- Preserve existing API envelopes, error formatting, authorization, and Git mutation behavior.

## Tasks

- [x] 1. Add the persistent user-default-domain model, repository operations, validation, and focused repository tests.
- [x] 2. Add authenticated API get/set/unset routes and use persisted decisions during project creation, with handler tests for fallback, precedence, authorization, and unset behavior.
- [x] 3. Add CLI invocation parsing and help for `user default-domain get|set|unset`, with parser tests.
- [x] 4. Add CLI API dispatch and human/JSON output behavior, with runner tests.
- [x] 5. Update public documentation and exports, then run focused tests, typecheck, and the full single-concurrency test suite.

## Paths

- `src/project-store/ProjectRepository.ts`
- `src/project-store/projectRepositoryOpen.ts`
- `src/project-store/projectRepository.test.ts`
- `src/user-default-domain/`
- `src/api/projectRegistryApiHandlerCreate.ts`
- `src/api/projectRegistryApiHandlerCreate.test.ts`
- `src/project/projectCreate.ts`
- `src/cli/ProjectRegistryCliInvocation.ts`
- `src/cli/projectRegistryCliArgumentsParse.ts`
- `src/cli/projectRegistryCliArgumentsParse.test.ts`
- `src/cli/projectRegistryCliRun.ts`
- `src/cli/projectRegistryCliRun.test.ts`
- `src/cli/projectRegistryCliHelp.ts`
- `src/index.ts`
- `README.md`
