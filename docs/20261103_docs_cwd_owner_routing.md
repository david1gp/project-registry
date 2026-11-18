# Directory-aware docs publishing (cwd → owner space)

## Goal

Unix user `david` runs `project-registry docs <path>`:

- cwd under `/projects`, `/servers`, `/adaptive`, `~/adaptive`, `~/leo` → publish into owner `leo`'s docs space (`docs.wonder1.de`)
- anywhere else → publish into owner `david`'s space (`docs.david-siewert.com`) — unchanged behavior

Nothing existing may break: without the new config file / env key, behavior is byte-for-byte identical.

## Decisions

- Target is leo's existing docs space (shared with leo), not a second david space on wonder1.de.
- Folder rules live in a **client-side** config file of the invoking user, not in daemon config.
- Rules select an **owner** (the daemon already maps owner → default domain → `docs.<domain>`).
- Server grant is **docs-publication only**, not owner-wide (do NOT use `PROJECT_REGISTRY_SHARED_OWNERS` for this; it grants full owner access and is group-based).
- Only `docs <path>` (publish) is affected. `docs <name> <path>` stays as is.

## Current state (facts)

- CLI: `src/cli/projectRegistryCliRun.ts` (~488-503) POSTs `{ sourcePath, markdown, pagePath }` to `/api/v1/users/<owner>/docs/publications`; owner = `environment.USER`. Parser: `src/cli/projectRegistryCliArgumentsParse.ts` (docs branches ~1004-1024 reject `--owner`). Help: `src/cli/projectRegistryCliHelp.ts`.
- Daemon handler: `src/api/projectRegistryApiHandlerCreate.ts` (~1599-1732) calls `projectOwnerAuthorize(resolvedAccess, actor, owner)`; rules in `src/access/projectAuthorize.ts`. Env config parsed in `src/runtime/projectRegistryDaemonConfigFromEnv.ts`.
- Live: david's socket gets 403 for owner `leo`. Daemon runs root-mode on wonder1-server (this machine). Installer: `~/leo_internal/dev-servers/wonder1-server/caddy/install/wonder1ProjectRegistryInstall.ts` (applies only selected env keys live), env source `~/leo_internal/dev-servers/wonder1-server/caddy/project-registry/project-registryd.env`, live env `/etc/project-registry/project-registryd.env`.
- `valibot` is available for validation. Tests: `bun --conditions=browser test <file>`, concurrency 1.

## Approach

### A. Daemon: docs publisher grant

- New optional env key `PROJECT_REGISTRY_DOCS_PUBLISHERS`, JSON object `{ "<owner>": ["<username>", ...] }`, e.g. `{"leo":["david"]}`. Absent/empty → no change. Malformed → config error like other keys.
- In the docs publications POST handler only: if `projectOwnerAuthorize` fails and the actor's username is listed for that owner, allow the request. All other endpoints unaffected.

### B. CLI: config file + owner selection

- Config path: `${XDG_CONFIG_HOME:-$HOME/.config}/project-registry/config.json`. Missing file → current behavior.
- Format:
  ```json
  {
    "docs": {
      "rules": [
        { "paths": ["/projects", "/servers", "/adaptive", "~/adaptive", "~/leo"], "owner": "leo" }
      ]
    }
  }
  ```
- Matching: expand leading `~` to `$HOME`; compare against cwd (both as given and realpath'd); segment-boundary prefix match (`/projectsX` must not match `/projects`); longest matching path wins; no match → `$USER`.
- `docs <path> --owner <owner>` allowed explicitly and overrides config.
- Invalid config (bad JSON / schema) → clear CLI error, no publish.
- Help text updated (owner's docs space now "selected by --owner, config rules, or $USER").

## Tasks

1. Daemon grant (A) + unit tests. — done when tests for config parsing + handler authorization pass.
2. CLI config + `--owner` for docs publish (B) + unit tests. — done when CLI tests pass.
3. Merge both into main, build, run related test files.
4. Deploy: install new build on wonder1-server, add `PROJECT_REGISTRY_DOCS_PUBLISHERS={"leo":["david"]}` to installer env source and live env, restart `project-registryd`, create `/home/david/.config/project-registry/config.json`.
5. E2E: as david publish a test md from `~/adaptive/...` (→ docs.wonder1.de) and from `~/personal` (→ docs.david-siewert.com); verify in browser; verify leo/other owners unaffected; clean up test pages if possible.

## Status

- Task 1: done (branch `daemon-docs-publishers-grant`, commit 6dbc036)
- Task 2: done (branch `docs-owner-config-selection`, commit fc3c0b1)
- Task 3: done (merged to main, db8784e)
- Task 4-5: pending
