# Owner documentation space

The former cwd-project fallback has been replaced by a single owner-scoped documentation space. `project-registry docs <path>` reads a local Markdown file and publishes it to the authenticated owner's space regardless of cwd registration or project docs settings. There is no docs alias: the single-path `docs` form publishes, while `docs <project> <path>` remains explicit legacy project-hosted URL lookup and preserves its existing `--http` behavior.

## Local path compatibility

Relative inputs resolving within cwd become normalized logical page paths and keep their hierarchy: `docs/../guide.md` resolves to `guide.md`. Relative inputs resolving outside cwd, such as `../guide.md`, and absolute inputs publish under their basename. This preserves access to local files without permitting traversal in the logical page path. The generated `index.md` is reserved.

Logical page paths are relative Markdown paths made only of ASCII letters, digits, `.`, `_`, `-`, and `/`, matching the route-safe characters accepted by the API and Caddy routes. Identical logical paths update the same page within one owner. Existing publications and legacy API clients that send only an absolute `sourcePath` remain supported; this compatibility change does not migrate or delete publications.
