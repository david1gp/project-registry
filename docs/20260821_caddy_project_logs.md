# Per-project Caddy access logs

## Goal

Let an authenticated consumer view bounded, complete raw Caddy access logs for every active Caddy project they are authorized to read, without exposing Caddy's admin API, arbitrary files, another project's traffic, or unbounded log streams.

## Decisions

- Caddy writes one JSON access-log stream per active `(owner, name)` project. A named logger is mapped to every domain on that project's server route.
- A shared SHA-256 identifier derived from the encoded `(owner, name)` tuple is used for the logger and directory. Domain changes do not move logs, and owner/name values never become filesystem paths.
- Production logs live outside the Git repository at `${PROJECT_REGISTRY_CADDY_ACCESS_LOG_ROOT}/projects/<project-id>/access.jsonl`. Logging is omitted when the root is unset, so local development remains opt-in.
- Caddy owns file writing and rotation: 25 MiB files, daily roll, compression, seven-day retention, and at most eight archives. The daemon only reads and reconciles expired inactive directories.
- Stored records preserve the complete Caddy JSON object, including request/response headers, query strings, credentials, and full client addresses. The parser and transport retain structural and resource bounds without privacy filtering or field redaction.
- The first release provides finite, cursor-paginated reads and UI polling, not SSE, WebSockets, raw downloads, searching, exports, or cross-project aggregation.
- The CLI has feature parity through `project-registry project access-logs <name> [--owner <owner>] [--limit <n>] [--before <cursor>]`. The owner defaults to the socket-bound username; an explicit owner supports authorized admin access. Continuous `--follow` is deferred with other live streaming.
- The API returns each bounded raw Caddy JSON object without a public-field allowlist or redaction.
- Every request resolves the current actor and reuses project-read authorization. Missing and unauthorized projects both return `404`; catalog-only, disabled, or unavailable logging has an explicit unavailable result.
- Callers never submit filesystem paths or logger IDs. In the trusted internal deployment, opaque versioned cursors are
  unsigned, strictly structurally validated, rebound to the requested project and source fingerprint, and expire by time
  or when rotation invalidates their source.
- The daemon remains loopback-only and Caddy's localhost admin API is never proxied to consumers.
- Retention reconciliation accepts at most 1,024 raw active project IDs per call; IDs must be valid and unique, and an over-limit input is rejected without metadata mutation or deletion.

## Approach

- Extend the generated Caddy JSON with top-level named loggers and `apps.http.servers.srv0.logs.logger_names` host mappings. Exclude project access loggers from the default logger to avoid duplicate journal records.
- Centralize project-log identity and path derivation so Caddy generation, the reader, and retention reconciliation cannot disagree.
- Add an `access-log` bounded context with a filesystem source, bounded raw Caddy JSON parser, cursor codec, list use case, and typed results. Bound record count, line size, scanned/decompressed bytes, JSON value size/depth/container/node counts, and malformed-line handling; reject symlinks and non-regular files.
- Expose `GET /api/v1/users/:owner/projects/:name/access-logs?limit=<n>&before=<cursor>` through the existing daemon HTTP request-handler boundary. Return `Cache-Control: no-store`; use `400` for invalid input, `410` for an expired cursor, and `503` when logging storage is disabled or unreadable.
- Route the CLI command through the same versioned handler over the selected per-user Unix socket. Derive actor identity only from the socket-bound username, use it as the omitted owner default, authorize any explicit owner normally, invoke the same list use case, and support both human-readable and stable JSON output without direct filesystem access.
- Add a German-labelled access-log panel to project details with refresh/pause, ten-second polling while visible, older-page loading, and explicit empty, unavailable, expired-cursor, and partial/malformed-record states.
- Provision the optional log root with Caddy-owned `0700` directories. Caddy's writer explicitly creates `0600` files and
  `0700` directories; root `project-registryd` reads the logs and owns its `0600` retention metadata. Do not audit or
  repair existing log entries during installation, and do not install a custom Caddy umask drop-in.
- After a successful Caddy application, reconcile project log directories. Keep active projects, retain newly inactive directories for the retention window, then atomically quarantine expired directories without following links; quarantine cleanup is deferred.
- Roll out behind the log-root environment setting: native Caddy validation and raw-record fixtures first, then a one-project staging canary, then production enablement.

## Tasks

- [x] 1. Add shared project access-log identity/path derivation, daemon configuration for the optional log root, strict root validation, and unit tests for stable IDs and traversal-resistant paths.
- [x] 2. Generate per-project named Caddy loggers, host mappings, raw JSON encoding with credential logging, rotation settings, and default-logger exclusions; cover active, disabled, catalog-only, multi-domain, and collision cases with snapshots.
- [x] 3. Implement the bounded file source, raw bounded-JSON parser, gzip archive reading, reverse chronological paging, opaque cursor codec, resource limits, symlink defenses, and rotation-race results with filesystem fixtures.
- [x] 4. Implement the project access-log list use case and daemon API route, reusing actor resolution and project authorization; test the role matrix, indistinguishable `404`s, input/status mapping, no-store headers, and unavailable storage.
- [x] 5. Add `project-registry project access-logs` over the per-user Unix socket with optional `--owner`, bounded paging, and human/JSON output; test owner inference, explicit-owner authorization, command parsing, request parity, socket-bound identity, cursors, and unavailable-storage errors.
- [x] 6. Add the project-detail access-log client and panel using reusable `#ui` components, including inspectable raw JSON records; test paging, polling cleanup, refresh/pause, visibility changes, and all empty/error states, then verify the rendered flow in a browser.
- [x] 7. Add inactive-directory retention reconciliation after successful Caddy application, with mount-safe no-follow quarantine transitions, a 24-hour cleanup grace, a 1,024 raw active-ID bound, serialized one-daemon reconciliation, and tests for active, recently inactive, expired, crash recovery, races, and malicious filesystem entries.
- [x] 8. Update systemd/migration installation and environment templates to create the Caddy-owned `0700` log root with `0600` files, and document capacity/retention and the opt-in rollout switch.
- [ ] 9. Add an explicit opt-in end-to-end check for a disposable staging deployment that sends requests containing query secrets, cookies, authorization headers, and distinct project hosts; prove complete-record preservation, project isolation, permissions, rotation continuity, HTTP/Unix authorization parity, and bounded disk/read behavior, document its required staging inputs and safe invocation, then run it before enabling production.
  - Current: implementation and local verification are complete. Next, run the documented attestation and live E2E check against a disposable root-provisioned staging target; production remains disabled.

## Paths

- Existing Caddy generation/config: `src/caddy/caddyConfigGenerate.ts`, `src/caddy/caddyConfigOptionsSchema.ts`, `src/caddy/caddyApplicationCreate.ts`, `src/caddy/CaddyApplicationQueue.ts`
- Existing project/auth/session boundaries: `src/project/projectSchema.ts`, `src/project/projectGetUseCase.ts`, `src/access/ProjectAccess.ts`, `src/access/projectAuthorize.ts`, `src/session/sessionActorResolve.ts`
- Existing runtime/API boundary: `src/runtime/ProjectRegistryDaemon.ts`, `src/runtime/ProjectRegistryDaemonConfig.ts`, `src/runtime/projectRegistryDaemonConfigFromEnv.ts`, `src/runtime/ProjectRegistryDaemonRequestHandler.ts`
- New access-log context: `src/access-log/ProjectAccessLogRecord.ts`, `src/access-log/ProjectAccessLogSource.ts`, `src/access-log/projectAccessLogId.ts`, `src/access-log/projectAccessLogPath.ts`, `src/access-log/projectAccessLogCursor.ts`, `src/access-log/projectAccessLogSourceFileCreate.ts`, `src/access-log/projectAccessLogListUseCase.ts`, `src/access-log/projectAccessLogRetentionReconcile.ts`
- API/UI additions: `src/api/`, `src/web-server/`, `src/ui/project/ProjectAccessLogPanel.tsx`, `src/ui/project/projectAccessLogRecordSummary.ts`, `src/ui/project/`
- CLI additions: `src/cli/`, `src/cli.ts`
- Operations: `ops/migration/project-registryd.service`, `ops/migration/project-registryd.env`, `ops/migration/install-project-registryd.bash`, `ops/migration/README.md`
- Tests: adjacent `*.test.ts`/`*.test.tsx` files plus Caddy fixtures under the existing Caddy test structure
