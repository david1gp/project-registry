# Fallback document publishing

## Goal
When `project-registry docs <path>` cannot match cwd to a registered project, publish the document through an automatically created, persisted `doc` project at `doc.<owner default-domain>`. Accept relative client paths, resolve them against cwd, and list published documents by absolute source filesystem path. Preserve matched-project and explicitly named docs behavior.

## Decisions
- The fallback is owner-scoped and created automatically on first use using existing project/domain/Caddy lifecycle.
- The client reads the selected Markdown file and sends its absolute source path and content to a dedicated authenticated publication endpoint. Store only explicitly published files in a narrow server-owned docs directory; never expose the filesystem root.
- Stable file identifiers allow repeat publication to update the same document. Generate a Markdown index whose labels are absolute source paths. Reuse existing docs rendering and URL generation.
- Use existing dependencies and conventions. An absent default domain produces an actionable error. Do not overwrite an unrelated project named `doc`.
- Persist publication metadata in the dedicated publication directory rather than growing project labels with every document. A project label can identify the managed fallback project.

## Approach and tasks
1. Implement server-side fallback publication, persisted automatic project creation, safe storage/index, and focused tests.
2. Implement CLI unmatched-project fallback with absolute source path/content, focused tests, and user documentation.
3. Run relevant serial tests and typecheck; verify serving behavior with a browser where needed.
4. Hand off to a fresh Luna agent to load the commits skill, commit/push, and deploy using the existing installer.
5. Verify actual publication and rendered document/index locally and as `ssh leo@leo-server`.

## Verification
Tests must have maximum concurrency one and no watch mode. After failure rerun only the failing file/test. Avoid unrelated full-suite/e2e runs. Live tests must exercise first creation or existing managed fallback, relative paths outside registered projects, repeat publication, absolute-path index labels, and unchanged registered-project behavior.

## Current status
Tasks 1–5 complete. Backend endpoint is `POST /api/v1/users/{owner}/docs/publications` with `{sourcePath, markdown}` and returns `{project, file, index, urls, indexUrls}` inside the normal success envelope. Managed storage is `/var/lib/project-registry-docs`, separate from private daemon state, with an empty static root and readable publication directories/files. Existing DNS and Caddy lifecycle is reused. Deployment refreshes existing user CLI installations. DNS retries yield to pending projects. David’s owner DNS credential needs zone access for durable automatic reconciliation; the current docs A record exists separately.
