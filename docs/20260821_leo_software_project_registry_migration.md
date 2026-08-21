# Leo Software Project Registry migration

## Goal

Make `/home/david/leo/software` load its project catalog from the active Project Registry daemon instead of `data/projects/*.yml`, while preserving the existing authenticated dashboard, browser API, project ordering, links, and allow-listed user-service controls.

## Decisions

- Treat Project Registry as the only authoritative project source; do not merge with or fall back to the Software YAML records.
- Read through the daemon API over Bun's Unix-socket `fetch`, using `/run/project-registry/leo.sock` and the owner-scoped `GET /api/v1/users/leo/projects` route by default.
- Keep the socket path and owner server-side and configurable as `PROJECT_REGISTRY_SOCKET` and `PROJECT_REGISTRY_OWNER`; never accept an owner from the browser.
- Preserve Software's existing `/api/projects` and `/api/services` browser contracts and map registry camelCase fields to the current UI-facing snake_case project shape in one server adapter.
- Keep service status and start/stop/restart execution in Software because Project Registry does not yet implement service endpoints; derive the service allow-list from registry projects instead of YAML.
- Return a stable server error when the registry is unavailable or returns an invalid envelope; do not present an unavailable registry as an empty project list.
- Do not expose owner in the UI while Software remains a single-owner deployment.

## Approach

1. Add a small server-only Project Registry client that requests and validates the `leo` project snapshot over the configured Unix socket and projects it into Software's existing project model.
2. Replace the YAML-backed store with the registry client, making project reads asynchronous and preserving deterministic order and optional field behavior.
3. Keep the current Software API and UI unchanged while adapting service status/actions to use the registry-backed project list for unit authorization.
4. Configure the deployed Software user service to access the Leo socket, then verify the registry and legacy catalogs match before removing the YAML project source from runtime use.

## Tasks

- [ ] 1. Add a server-only registry client with configurable socket/owner, response-envelope validation, registry-to-Software field mapping, deterministic sorting, and focused success/error tests.
- [ ] 2. Replace `src/server/store.ts` YAML scanning with the registry client and update callers for asynchronous reads without adding a legacy fallback.
- [ ] 3. Preserve `/api/projects`, `/api/services`, and service-action payloads while sourcing project metadata and the systemd unit allow-list from registry records; map registry failures to a stable API error.
- [ ] 4. Add API and service authorization tests covering authentication, unavailable or malformed registry responses, optional project fields, ordering, unknown projects/units, and allowed service actions.
- [ ] 5. Add `PROJECT_REGISTRY_SOCKET=/run/project-registry/leo.sock` and `PROJECT_REGISTRY_OWNER=leo` to the Software service deployment and document Project Registry as the authoritative project source.
- [ ] 6. Compare the deployed registry-backed project and service lists with the legacy YAML-backed results, verify dashboard links and service actions, then remove `data/projects/*.yml` and obsolete project-store parsing code.

## Paths

- `/home/david/leo/software/src/server/projectRegistry.ts`
- `/home/david/leo/software/src/server/projectRegistry.test.ts`
- `/home/david/leo/software/src/server/store.ts`
- `/home/david/leo/software/src/server/api.ts`
- `/home/david/leo/software/src/server/api.test.ts`
- `/home/david/leo/software/src/server/services.ts`
- `/home/david/leo/software/src/lib/projects.ts`
- `/home/david/leo/software/ops/software.service`
- `/home/david/leo/software/ops/install-service.bash`
- `/home/david/leo/software/AGENTS.md`
- `/home/david/leo/software/data/projects/`
- `src/api/projectRegistryApiHandlerCreate.ts`
- `src/cli/projectRegistryCliRequest.ts`
- `docs/20260820_project_registry_migration.md`
