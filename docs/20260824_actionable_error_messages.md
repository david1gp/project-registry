# Actionable error messages

## Goal

Make user-visible CLI, API, documentation, access-log, session/login, and directory errors specific and actionable, with stable structured error details where clients need them.

## Decisions

- Use a concise `error` plus optional `hint` presentation for human CLI output.
- Distinguish disabled projects, disabled documentation, missing or inaccessible projects, invalid input, configuration failures, and transient service failures.
- Preserve authorization-safe ambiguity where distinguishing missing from inaccessible would disclose information.
- Preserve compatible API envelopes while adding stable error codes or hints without parsing human message text.
- Keep internal filesystem diagnostics unchanged unless they are exposed to users.
- Follow repository TypeScript conventions and run tests with concurrency 1.

## Approach

- Add structured actionable error information at domain/API boundaries.
- Format CLI failures consistently from structured responses.
- Improve validation, daemon communication, documentation, access-log, session/login, and directory messages.
- Update focused tests after each increment, then run the complete verification suite.
- Commit and push the changes in conventional commits, then publish a release and resolve any GitHub Actions runner failures caused by the release changes.

## Tasks

- [x] 1. Establish structured API/CLI error codes and optional hints without message-string matching.
- [x] 2. Distinguish documentation failure states and provide exact enablement commands.
- [x] 3. Improve CLI syntax, project-name validation, daemon connectivity, and protocol errors.
- [x] 4. Improve access-log API and UI errors with actionable recovery guidance.
- [x] 5. Improve user-facing session, login-provider, and directory failure guidance while preserving safe ambiguity.
- [x] 6. Run focused and full verification, fixing regressions.
- [ ] 7. Create and push conventional commits using the commits workflow.
- [ ] 8. Create the release, inspect GitHub Actions runs, and fix runner failures if any occur.

## Paths

- `src/api/`
- `src/cli/`
- `src/caddy/`
- `src/access-log/`
- `src/ui/project/`
- `src/session/`
- `src/zitadel/`
- `src/identity/`
- `docs/20260824_actionable_error_messages.md`
