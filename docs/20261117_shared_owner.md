# Shared owner namespace

## Goal

Add one shared part of the project registry, owner `shared`, that Linux users david, leo, tim and mit (the members of Linux group `projects`) can all read and write. Private owner rows stay private. Move leo's project rows that live under `/projects` into `shared`. Then point david-server's Lighthouse timer at `shared` directly instead of reading leo's rows over SSH.

## Decisions

- Owner name `shared`, stored like any other owner: `projects/shared/<name>.json`.
- Membership is the Linux group `projects`, resolved by the root daemon at request time (`getent group projects` or parsing `/etc/group`, behind an injectable resolver). No hardcoded user list.
- Members get full access to `shared`: list, get, create, edit, delete, history and docs. A member's default `project list` (no owner given) includes shared rows.
- Configuration is a daemon env var: `PROJECT_REGISTRY_SHARED_OWNERS=shared:projects` (comma-separated `owner:linuxGroup` pairs). If it is unset, no shared owners exist.
- Credentials: `shared` reuses leo's credentials for Cloudflare DNS, private DNS/Tailscale and private TLS, through `PROJECT_REGISTRY_CREDENTIAL_OWNER_ALIASES=shared:leo`, which maps owner to credential owner. Tailscale zone policy: `shared` gets the same zone as leo (`wonder1.de`).
- Scope: only the Unix-socket access path (the CLI). Zitadel/OIDC web access is unchanged; admin and superadmin already see every owner.
- Migration covers leo rows whose `labels.sourcePath` starts with `/home/leo/projects/` or `/projects/`. Note that `/home/leo/projects` is a symlink to `/projects`. Their `sourcePath` is rewritten to `/projects/<rest>`. Each row moves in one repository transaction (write the shared row and remove the leo row, one commit), which keeps DNS and Caddy claims continuous.
- Accepted side effects, with no extra work: access-log paths and docs publications are keyed by owner, so history stays under leo's old key.

## Approach

### project-registry (`~/adaptive/project-registry`)

- `src/access/projectAuthorize.ts`: allow an actor when the owner is a shared owner and the actor is a member of it. Keep the existing own/admin/superadmin rules unchanged.
- Socket access in `src/runtime/projectRegistryDaemonCreate.ts` (~1391-1422): add shared-owner membership resolution for the socket username. The actor identity stays the same.
- Config: parse the new env vars in `src/runtime/projectRegistryDaemonConfigFromEnv.ts`.
- Credential resolvers (Cloudflare, private DNS, private TLS): resolve through the owner alias before looking up credential files. DNS tracking keeps using the real owner `shared` as the project key.
- `src/project/projectTailscaleZonePolicy.ts`: add `shared`.
- Wiki sync (`src/runtime/projectRegistryWikiSyncCreate.ts`, currently filtered to `leo`): include `shared` rows in the same wiki root as leo. A moved row must keep the same page, with no duplicate pages.
- Static ACL repair (`src/project/projectStaticAclRepair.ts`): for owner `shared`, accept roots under `/projects/...`.
- CLI: `--owner <owner>` is parsed but not propagated today. Propagate it for `project list/get/create/edit/delete/history`; when omitted, behave as before.
- New operation `project move <name> --owner <from> --to-owner <to> [--source-path-rewrite <fromPrefix>=<toPrefix>]`: one `transact` call (write the new row and remove the old one) with the expected revision. The actor must be authorized for both owners.

### dev-servers (`~/leo_internal/dev-servers`)

- `wonder1-server/caddy/project-registry/project-registryd.env`: add `PROJECT_REGISTRY_SHARED_OWNERS=shared:projects` and `PROJECT_REGISTRY_CREDENTIAL_OWNER_ALIASES=shared:leo`, and make the installer apply both keys (`wonder1ProjectRegistryInstall.ts` ~109-120).
- Migration script (committed, check/apply, run as leo over the `wonder1-server` SSH alias): list leo rows, select by `sourcePath` prefix, and call `project move ... --to-owner shared --source-path-rewrite /home/leo/projects/=/projects/`. Dry run by default; `--apply` executes.
- Lighthouse (`david-server/timers/jobs/customer_web_lighthouse/lighthouseConfigCreate.ts` and related): read `project-registry --json project list --owner shared` locally, then remove the SSH call and the `/home/leo/projects` to `/projects` mapping.

## Rules for subagents

- Follow the `code-style` skill: Result instead of throws, one export per file, subject-first names.
- Use the libraries already in package.json; add no dependencies.
- Tests: run only the affected test files, `bun --conditions=browser test <file>` in project-registry and `bun test <file>` in dev-servers, plus `bun run typecheck` in project-registry. Don't run the full suite until the final verification task.
- Never touch production (no deploy, no ssh writes) unless the task says so.

## Worktrees

- project-registry: `/tmp/pr-shared-A8Zj/project-registry`, branch `feat/shared-owner`
- dev-servers: `/tmp/pr-shared-A8Zj/dev-servers`, branch `feat/shared-registry-owner`

## Tasks

1. [x] registry: shared-owner config, group-membership resolver, socket access, authorize/list, plus tests
2. [x] registry: CLI `--owner` propagation, plus the `project move` operation and its CLI, with tests
3. [x] registry: credential owner alias, Tailscale zone, wiki sync including shared, static ACL for shared, with tests
4. [x] dev-servers: env and installer keys, migration script, Lighthouse switch, with tests
5. [x] verify: full registry test suite and typecheck, plus the affected dev-servers tests; review the diff against the plan
6. [ ] ship: commits, merge to main, deploy the daemon, update the CLI for david/leo/tim/mit, run the migration, live checks (each of david/leo/tim/mit lists shared; a private row is still forbidden; Lighthouse dry run)

## Current context

- Task 1 model: socket access returns owner-role marker `shared-member` (after an injected group check, `src/runtime/projectRegistryGroupMembersResolve.ts`, getent, no cache); the actor stays unchanged. 
- Task 3: the alias wrapper is `src/runtime/projectRegistryCredentialOwnerAliasWrap.ts` (Cloudflare and private TLS). Private DNS uses one tailnet-wide credential, so it needs no alias. Wiki: when names collide across leo and shared, both rows are skipped and reported.
- Task 4: migration check mode selects 44 leo projects (161 service rows); 24 rows without sourcePath and 8 with other paths stay with leo. The env keys go through the existing managed-env payload (`registry-idle-disabled-env.bash`).

- Move: notifies edit(new key) and delete(old key); Cloudflare delete rechecks snapshot claims, so the record is retained. A default `project list` uses a new unscoped endpoint (own rows plus shared).
- Known baseline failures (not ours): dev-servers has 77 failing tests and 31 typecheck errors that already exist at base.
- Base commits: project-registry `73f0f8a`, dev-servers `b970bd79`.
- Uncommitted changes from another agent are in the dev-servers main checkout (projects-permissions setup). Do not touch them.
