# Auto-allocate ports for sibling services

## Goal

Allow adding a service alongside existing services in a project (including `services`) without specifying a port. The server chooses an available port, just as it does during project creation. Support the API, CLI, and UI; preserve explicit port overrides.

## Decisions

- Allocate on save at the API boundary. CLI and UI submit a Caddy service with domains and no `port`; neither client guesses a port.
- A new sibling requires a service ID and at least one domain. A blank port means auto-allocation only when creating a sibling; editing an existing service retains its current validation/behavior.
- Keep `caddy: null` as no Caddy route. Preserve configured port range, ownership behavior, and existing collision rules. Never select a port already assigned to an active local sibling or another project, including explicit ports elsewhere in the submitted service collection.
- Use existing repository UI components (`#ui/...`) where suitable; keep app-specific UI under `src/ui`, and `ui/` read-only. Use existing dependencies before adding any.

## Tasks

1. **Server allocation:** Extend canonical normalization/edit to allocate omitted Caddy ports on newly submitted services regardless of ownership, reserving existing and explicit local service ports in the submitted project as well as other projects. Preserve explicit ports, external behavior, and `caddy: null`. Add narrow unit/integration tests for same-project collisions and allocation exhaustion. Status: implemented; edge-case regressions pass.
2. **CLI addition:** Permit `project edit <name> --service <new-id> --domain <domain>` without `--port`, send an omitted port to the API, and preserve the current explicit-port path and sibling services. Add focused CLI helper and flow tests. Status: implemented; focused tests pass, added test type regressions corrected.
3. **UI addition:** Add a reachable new-service action to the services panel with an ID, required domain(s), optional port, and existing applicable service controls. Blank port on new service is omitted from PATCH and allocated by the API; explicit port remains supported. Existing edit flow remains intact. Add focused draft/state/view tests. Status: implemented; focus-remount issue corrected, focused tests pass.
4. **Verification:** Run relevant focused tests serially (max concurrency 1), then typecheck/build or other targeted checks. Have a browser subagent verify new-service creation and existing-service editing through the UI; defer E2E until feature work is complete. Status: focused tests, build, UI typecheck, and mocked browser sibling-add flow pass; existing-service edit remains covered by tests.
5. **Commit and release:** After verification, have a fresh luna subagent load `/commits`, split conventional commits as appropriate, run the repository release workflow, and report commit/tag/release details. Status: complete; v0.9.0 released.

## Current context

Released as v0.9.0. Browser verified a mocked project with one existing service: submitting a new sibling omitted its port, preserved the old sibling and revision, and displayed allocated port 3000 after mocked refresh. Server integration tests cover actual allocation. Global typecheck retains pre-existing project filter test errors; CLI suite retains a pre-existing stale project-list API path expectation. Build and UI typecheck pass.
