# Delete project by port

## Goal

Restore legacy API compatibility for `DELETE /projects/by-port/:port` and allow the CLI to delete the current owner's project by Caddy port.

## Decisions

- Keep the route owner-scoped through existing request authentication.
- Reuse existing project deletion and Caddy regeneration behavior.
- Preserve the legacy success envelope and not-found behavior.
- Support the legacy CLI form `delete --port <port>` without changing current project-name deletion.

## Approach

- Add route parsing and API handling for deletion by port.
- Resolve exactly one owner project by its configured Caddy port.
- Map the operation through existing deletion use cases and response formatting.
- Add CLI parsing, execution, help, and focused compatibility tests.

## Tasks

- [x] 1. Add and test the legacy delete-by-port API route.
- [x] 2. Add and test `delete --port <port>` CLI compatibility.
- [x] 3. Review the full change and run focused and full verification.

## Paths

- `src/api/projectRegistryApiHandlerCreate.ts`
- `src/api/projectRegistryApiHandlerCreate.test.ts`
- `src/cli/ProjectRegistryCliInvocation.ts`
- `src/cli/projectRegistryCliArgumentsParse.ts`
- `src/cli/projectRegistryCliArgumentsParse.test.ts`
- `src/cli/projectRegistryCliHelp.ts`
- `src/cli/projectRegistryCliOutputFormat.ts`
- `src/cli/projectRegistryCliRun.ts`
- `src/cli/projectRegistryCliRun.test.ts`
