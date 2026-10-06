# Owner documentation space

## Goal

Provide one coherent Markdown documentation space per owner/account instead of isolated document publications. Local `project-registry docs <path>` publishes to this space from any working directory, independent of project registration or project docs configuration. Keep only the `docs` command.

## Decisions and compatibility

- Keep `docs <project> <path>` as explicit legacy project-hosted URL lookup.
- Preserve existing publication API requests and existing published URLs/files. Do not delete or rename legacy publications during rollout.
- Extend the existing owner publication store and managed `docs` hosting project; do not add another hosting system or dependencies.
- New publications use a normalized logical relative Markdown page path as their stable owner-space identity. The CLI preserves relative hierarchy for local inputs within the working directory; absolute inputs or paths outside the working directory use their basename so existing local file access remains usable. Reject unsafe logical page traversal and reserve the generated space index. Document that identical logical paths update the same page within an owner.
- Existing API clients supplying only absolute `sourcePath` retain legacy behavior. New clients also send `pagePath`.
- Generate a readable, organized space index with page titles and logical hierarchy; keep legacy entries accessible without exposing absolute source paths in the navigation.
- Provide a visible link to the space index on newly published or republished owner pages using existing Markdown/Caddy rendering. Previously stored pages retain their original bytes until republished. Avoid altering explicit project-hosted page content or broad UI redesign.
- Search, a new editor, bulk import tooling, and a separate frontend are outside this increment.

## Approach

Extend publication storage and metadata compatibly, then expose logical page paths through the existing API, and switch local CLI publishing to that endpoint unconditionally. Verify storage/API/CLI with focused tests, inspect rendered docs in a real browser, then commit and deploy through existing operational tooling.

## Tasks and status

1. Storage and index: complete. Extend the store contract, safe logical-path identity, legacy metadata compatibility, title/hierarchy navigation, and focused store tests.
2. Publication API: complete. Accept optional `pagePath`, preserve old request/response behavior and authorization, and add focused API tests.
3. Local CLI and user documentation: complete. Always publish the single-path command, derive logical paths safely, preserve explicit project lookup, update help/README and focused CLI tests.
4. Shared navigation and integrated verification: complete. Ensure owner pages link to their space home without breaking Markdown links or legacy URLs. Focused tests and browser verification, no full test suite.
5. Commit and deployment: complete. Implementation deployed; browser acceptance passed the new-page → space-home → new-page flow and the legacy URL. Final plan bookkeeping committed, pushed, and republished.

## Verification constraints

- Tests run with maximum concurrency 1; no watch mode. After a failure, rerun only the failing file/test.
- Check old API requests, legacy publication URLs/index inclusion, same logical page updated from different source locations, nested paths, unsafe/reserved paths, isolated owners, and concurrent updates.
- Check local CLI from a docs-disabled registered project and an unregistered cwd, and explicit project docs behavior.
- Use a browser subagent for rendered-page verification after implementation.
- Inspect deployment tooling before deployment; preserve existing docs storage and owner domain configuration.

## Current context

The implementation extends the store with optional logical page paths, organizes the owner index, adds canonical root-relative owner-page home links, and accepts the extended API body. Logical-path validation is shared across CLI/API/store, follows existing Caddy serving constraints, reserves internal root filenames even as directory components, and preserves literal logical paths beginning with `docs/` in returned URLs. Existing stored publications are left unchanged until explicitly republished. Navigation deduplication applies only to the exact canonical injected prefix; relative authored links retain their original targets.

Deployment uses `bash ops/deploy.sh`, backed by the existing installer under `~/leo_internal/dev-servers/leo-server/caddy/install`. It deploys the local built working tree and refreshes the installed CLI and daemon; a release tag is not required. The owner space is hosted at `docs.david-siewert.com`. This plan is now published at `/docs/docs/20261006_owner_docs_space.md` in that space; the legacy hashed publication remains accessible.

Final acceptance confirmed the new-page → space-home → new-page navigation and legacy URL in the browser. The completed plan is republished at `https://docs.david-siewert.com/docs/docs/20261006_owner_docs_space.md`; the older hashed publication was left untouched.
