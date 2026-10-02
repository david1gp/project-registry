# Project static ACL repair

## Goal
Add a `project-registry` CLI command to repair Caddy's filesystem access for an authorized project's static service roots, including the home-directory traversal ACL that caused `demos.leonardomora.de` 403s. Changes must be reproducible in the project-registry source and not just made on the live server.

## Decisions
- CLI command: `project fix-acl <name>`; output per-root repair result. It calls a versioned authenticated daemon endpoint; the unprivileged CLI does not invoke sudo or accept filesystem paths.
- Server uses existing owner/project authorization and derives roots from canonical project static Caddy services. No caller-provided paths. Repair all static services in the named project, deduplicating roots. Return an actionable error if none.
- Only repair roots under the project's matching owner home `/home/<owner>/projects/...` or exact `/home/<owner>/wiki` subtree as appropriate; do not grant access to other paths. Reject missing/symlinked path components and unsupported roots. Traverse only necessary ancestors, grant Caddy `--x`; grant recursive `rX` and default `rX` on each directory within each static root. Preserve ACL mask rights for existing principals. Avoid following symlinks during traversal. Fail visibly on setfacl or verification errors.
- The supported non-root service identity is `caddy`. Root Caddy skips repair after validating the authorized root and returns an explicit skipped status without filesystem access. Other configured non-root identities fail explicitly before filesystem access; identity-aware ACL delegation is not implemented. Keep ACL operations behind an injected/testable server-side adapter. Do not expose generic filesystem ACL modifications or change unrelated routes/content.

## Tasks
1. Implement narrow filesystem ACL repair helper and focused unit tests for path boundary, symlinks, inherited defaults, verification/failure. Use existing dependencies first.
2. Add authorized project-scoped daemon API endpoint invoking helper; focused API authorization and static-service tests.
3. Add CLI parser, command dispatch, help/docs and focused CLI tests.
4. Run targeted tests/build with single-test-worker constraints; perform narrow real daemon/browser verification only after deploying through existing reproducible installer if feasible, otherwise clearly report deployment status.

## Status
- Task 1: complete (helper and focused tests)
- Task 2: complete (authorized API and focused tests)
- Task 3: complete (CLI parser, output, help and tests)
- Task 4: in progress
