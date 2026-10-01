# Optional preserved Caddy JSON: pure merge contract

`caddyConfigBaseMerge(generatedConfig, options = {})` returns `Result<CaddyJsonObject>`.
Both configurations are full JSON objects; opaque Caddy/plugin fields are retained.
Options are validated by `caddyConfigBaseMergeOptionsSchema`:

- `baseConfig?`: complete imported Caddy JSON. Omitted: generated JSON is returned unchanged (fresh JSON value).
- `managedHosts?`: explicit exact-host deletion/replacement authority. Omitted: only new nonoverlapping hosts can be appended. Names compare case-insensitively, ignoring a final dot.
- `targetServerName?`: existing base HTTP server to receive generated routes. Defaults to the sole generated server's name (normally `srv0`). No server/listener inference or server creation.

## Ownership and deletion

Imported hosts are **not** implicitly Registry-owned. Do not feed inventory proxy candidates back into generation merely because they are representable: imports include custom compression, nested conditional routes, shared host routes and TLS/access-log policies.

Pass the union of previously managed hosts and currently managed hosts when replacing/deleting. A managed host present in the base but absent from generated routes is deleted. Keep deletion authority across reconciliations against an immutable base, or a deleted route would reappear. Without explicit authority a collision is an error, never a rewrite. The helper does not persist this ownership set.

Only one exclusive single-host, host-only top-level route in the selected base server may be replaced/deleted. Replacement stays at its original index and must retain its terminal value. Shared multi-host routes, multiple matching routes, top-level conditional/OR matchers, shared groups, wildcard/dynamic overlap and cross-server overlap fail closed. A top-level route without positive host scope is ambiguous for any affected host, even if nested host matchers exist; it is not rewritten or reordered. Nested routes under unrelated host-scoped sites are entirely opaque and remain unchanged.

New routes append in generated order, after all preserved base routes. They must be disjoint from every imported site's positive host matcher. Broad/hostless fallback routes cause rejection rather than inserting ahead of them and changing terminal behavior. Base relative order, terminal values, nested route/group order and all unrelated fields are preserved.

## Non-route configuration and TLS

Generated dependencies outside the route array merge only into missing fields or identical values. Object maps merge recursively; differing scalar/array values fail with their JSON path. There is no generic overwrite or array union: conflicting listeners, logging defaults/credentials, OIDC providers, TLS or admin policies require an explicit later policy decision. This avoids silently dropping a generated auth dependency or overwriting an imported policy. Existing apps (including PKI), TLS certificates/automation, logging, admin/storage and HTTP server policies survive unchanged.

Returned JSON is detached from both inputs. A later explicit local certificate reconciliation step can augment `apps.tls.certificates.load_files` on this returned full config while retaining existing certificates, tags, automation and other certificate loaders. This helper does not provision certificates, alter TLS, load/apply Caddy, wire environment/daemon options or mutate inputs.

Input JSON is expected to originate from JSON parsing/generation (not cyclic/proxy objects). This is structural JSON validation and conservative route-merging safety, not full Caddy module validation; callers must still run Caddy validation before any apply/cutover.
