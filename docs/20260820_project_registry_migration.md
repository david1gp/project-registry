# Project Registry migration

## Goal

Replace the Leo host's legacy `caddy-projects` daemon with `project-registry` while keeping one public Caddy on ports 80/443, preserving all project/domain routing, Caddy TLS state, project history, and reusable OIDC credentials, with a fast switch back to the old services.

## Decisions

- Perform the replacement on `leo-server`; keep `contentoren-server` and its independent root Caddy unchanged.
- Leo already runs the authoritative system `caddy.service` as user `caddy`, with live configuration under `/home/caddy/.config/caddy` and TLS state under `/home/caddy/.local/share/caddy`. Keep this Caddy running before, during, and after the daemon replacement.
- Replace only the system `caddy-projects.service` control daemon with `project-registryd`; both use the same local Caddy admin API at `127.0.0.1:2019` at different times.
- Do not copy stale `/home/leo` Caddy data over the established live `/home/caddy` data. Reuse the live data in place and make a non-destructive backup for rollback.
- Reuse Leo's existing confidential Caddy OIDC client values and cookie secret. Do not migrate users, plaintext passwords, browser sessions, or unrelated Contentoren/application credentials.
- Compare normalized route behavior rather than requiring byte-identical JSON. The explicit old admin listener and the new default admin listener may differ while both resolve to `127.0.0.1:2019`.
- Treat filesystem paths and loopback backends that are already unavailable in the parity-proven live configuration as preparation warnings, not migration blockers; the migration must not introduce new route differences.
- Include all Software records from Leo's historical `/home/leo/projects/software/data/projects` source and all current `david` records from the active legacy repository before cutover.
- Use one migration command with dry-run and apply modes for project records/history, plus a Leo deployment script that stages files without touching live ports and exposes explicit cutover and rollback commands.
- Keep every migration-specific script, command, fixture, test, service template, and supporting file under `ops/migration/`; do not scatter migration files across `src/`, `ops/systemd/`, or the Leo repositories.
- Roll back by stopping `project-registryd`, restoring the saved live Caddy JSON if needed, and restarting the retained system `caddy-projects.service`; keep `caddy.service` running.

## Approach

1. Clone the legacy project-data repository into a separate Project Registry repository, preserving history/remote/branch there and converting only the clone into `projects/<owner>/<name>.json`; never alter the repository used by the running legacy daemon.
2. Add deterministic candidate generation and a semantic parity check covering domains, listeners, upstreams, static roots, headers, docs/browse/SPA behavior, access rules, and OIDC handlers.
3. Add the production `project-registryd` unit and Leo staging configuration without starting it against the live Caddy admin API.
4. Use one preparation command that installs binaries/units, backs up the live Caddy configuration and TLS state without overwriting them, copies reusable OIDC values, migrates project data, captures the current admin API JSON, generates candidate JSON, and validates parity before staging.
5. Cut over only the control daemons while leaving the public system Caddy running, verify the known domains, and leave old services/data in place for immediate rollback.
6. Confirm Contentoren's independent Caddy routes and Cloudflare tunnels are unchanged; do not copy its `/var/lib/caddy` or credentials into Leo.

## Tasks

- [x] 1. Implement a legacy migration CLI under `ops/migration/` with `--dry-run` and `--apply`, cloning and converting the Leo project records without mutating the legacy repository, preserving Git metadata in the new repository, recording the completed migration, and rejecting unsupported template records.
- [x] 2. Add migration fixtures/tests for proxy, static, docs, browse, SPA, headers, disabled projects, access/OIDC settings, owner/name mappings, duplicate domains, and duplicate ports.
- [x] 3. Add an offline command that generates candidate Caddy JSON without calling the live admin API or mutating the source repository.
- [x] 4. Add a semantic parity command that compares legacy and migrated generated JSON, reports only meaningful route differences, and validates the candidate with the same OIDC-capable Caddy binary used in production.
- [x] 5. Add a production `project-registryd` systemd unit template and installer under `ops/migration/` with a verified Bun executable, migrated Git repository path, loopback web address, local Caddy admin URL, HTTPS listener, port range, Caddy binary, and mapped existing Leo OIDC environment values.
- [x] 6. Update the Leo preparation script to install the new daemon, back up rather than overwrite live Caddy config/TLS/OIDC state, migrate into a separate repository, capture the current admin API JSON, run parity before staging, and report existing unavailable static paths and loopback backends as warnings.
- [x] 7. Keep one migration wrapper with `prepare`, `cutover`, and `rollback` actions. `cutover` swaps only `caddy-projects.service` for `project-registryd`; `rollback` restores the saved legacy Caddy JSON through the production Caddy admin address and swaps the daemons back while `caddy.service` remains running.
- [x] 8. Run preparation on Leo while the old stack is live, confirm normalized parity and native Caddy validation, stage the replacement, and record existing unavailable static paths and loopback backends as non-blocking warnings.
- [x] 9. Cut over Leo, smoke-test project UI, authenticated routes, static/docs routes, and proxy routes, then keep the old Caddy data and legacy project repository until the rollback window is closed.
- [x] 10. Verify Contentoren still serves `codex.contentoren.de` and `email.contentoren.de` and that its tunnel-managed services remain unchanged.
- [x] 11. Confirm the historical Leo Software source is fully represented, synchronize any post-migration `david` legacy-record changes into the migrated repository, regenerate/validate the candidate, and leave the legacy repository untouched.
- [x] 12. Resolve post-cutover validation blockers: stop periodic and startup no-change Caddy reloads, expose owner-aware read/write socket APIs with usable permissions, optimize aggregate history, and prove rollback through the production admin address before final cutover.
- [x] 13. Replace the installed legacy `caddy-projects` CLI on Leo with a `project-registry` CLI using the active owner sockets, then remove the old CLI binary without changing the retained rollback daemon.
- [x] 14. Move the public Project Registry route to `project-registry.leonardomora.de`, configure DNS if required, and validate TLS and the public route.
- [x] 15. Update the Caddy-projects CLI instructions under `/home/david/personal/agents` to use the Project Registry CLI and its current commands/socket conventions.

## Paths

- `ops/migration/`
- `/home/david/leo/leo-server/caddy/projects/`
- `/home/david/leo/leo-server/caddy/generate.mjs`
- `/home/david/leo/leo-server/caddy/install/`
- `/home/david/leo/leo-server/caddy/service/`
- `/home/david/leo/leo-server/caddy/oidc/leonardomora.oidc.env`
- `/home/david/leo/contentoren-server/caddy/config/Caddyfile`
- `/home/david/leo/contentoren-server/shared/routes.json`
- `/home/caddy/.local/share/caddy`
- `/home/caddy/caddy-projects-history`
- `/home/leo/projects/software/data/projects`
- `/home/david/personal/agents/`
