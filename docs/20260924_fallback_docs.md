# Fallback document publishing

## Goal
When `project-registry docs <path>` cannot match cwd to a registered project, publish the document through an automatically created, persisted `docs` project at `docs.<owner default-domain>`. Accept relative client paths, resolve them against cwd, and list published documents by absolute source filesystem path. Preserve matched-project and explicitly named docs behavior.

## Decisions
- The fallback is owner-scoped and created automatically on first use as project `docs` at `docs.<owner default-domain>`, using the existing project/domain/Caddy lifecycle.
- The client reads the selected Markdown file and sends its absolute source path and content to a dedicated authenticated publication endpoint. Store only explicitly published files in a narrow server-owned docs directory; never expose the filesystem root.
- Stable file identifiers allow repeat publication to update the same document. Generate a Markdown index whose labels are absolute source paths. Reuse existing docs rendering and URL generation.
- Use existing dependencies and conventions. An absent default domain produces an actionable error. Do not overwrite an unrelated project named `docs`.
- Persist publication metadata in the dedicated publication directory rather than growing project labels with every document. A project label can identify the managed fallback project.

## Approach and tasks
1. Implement server-side fallback publication, persisted automatic project creation, safe storage/index, and focused tests.
2. Implement CLI unmatched-project fallback with absolute source path/content, focused tests, and user documentation.
3. Run relevant serial tests and typecheck; verify serving behavior with a browser where needed.
4. Do not migrate live projects, deploy, or commit in this increment. Hand off live migration only after this code change is reviewed and deployed separately.

## Verification
Tests must have maximum concurrency one and no watch mode. After failure rerun only the failing file/test. Avoid unrelated full-suite/e2e runs. Relevant tests exercise first creation or existing managed fallback, relative paths outside registered projects, repeat publication, absolute-path index labels, and unchanged registered-project behavior.

## Current status
The existing publication endpoint is `POST /api/v1/users/{owner}/docs/publications` with `{sourcePath, markdown}` and returns `{project, file, index, urls, indexUrls}` inside the normal success envelope. This increment changes the managed project/hostname contract from `doc` / `doc.<domain>` to `docs` / `docs.<domain>` only; owner-keyed publication storage under `/var/lib/project-registry-docs` remains unchanged. No live migration or deployment is performed here. The next agent should create the target `docs` project via normal publishing, verify its URLs and publications, then delete the old managed `doc` project through the existing project-delete API. Retain the old project until target publishing has succeeded; do not move or recreate publication storage.

The live target hostnames are `docs.david-siewert.com`, `docs.leonardomora.de`, and `docs.webflows.de`. Verify each owner's default domain, managed target project/Caddy route, DNS reconciliation, document and index URL reachability, and that the existing owner publication store remains visible before deleting that owner's old managed project. David's DNS credential currently needs zone access for durable automatic reconciliation; confirm this before the migration. Do not delete an unrelated project named `doc` unless it is verified as the old managed fallback.
