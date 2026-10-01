# Preserved Caddy baseline runtime wiring

Optional in both root and user mode:

```sh
PROJECT_REGISTRY_CADDY_BASE_CONFIG_PATH=/absolute/path/to/preserved-caddy.json
```

Equivalent daemon configuration: `caddyBaseConfigPath: "/absolute/path/to/preserved-caddy.json"`.
Omit the variable/property to retain ordinary generated-only behavior. Empty,
relative and NUL-containing paths are rejected. The file must be readable by the
daemon user and contain a complete JSON object, not a Caddyfile. It is read once
at `projectRegistryDaemonOpen`; invalid JSON/unreadable files fail open before
repository creation. Changes to this immutable baseline require daemon reopen.

The common application `configReconcile` pipeline is:

1. Generate current Registry locally-owned, active Caddy routes/dependencies.
2. `caddyConfigBaseMerge(generated, { baseConfig })` preserves imported routes,
   opaque plugin fields and policies; append only disjoint Registry domains.
3. If local automation is explicitly enabled, derive the active hostname union
   from the **merged configuration**, then provision certificates and hosts.
4. Serialize, Caddy validate, then admin load. Failures before validation/load
   prevent those later steps. Preserved-base configuration forces this startup
   path even if generated-config initialization was requested.

Runtime does not supply `managedHosts` and provides no env replacement authority:
an imported host collision fails closed. Baseline sites in Services metadata
must remain externally owned, not regenerated as proxy candidates. The separate
pure helper's explicit managed-host policy is not an approved runtime setting.
Its default target is `srv0`, which must already exist and have compatible
listener/dependency policies. Unsupported conflicts are rejected, not overwritten.

## Simpler deletion model

Keep the baseline limited to imported sites, excluding all newly generated
Registry sites. Each reconciliation starts from that same immutable baseline and
current Registry snapshot. Deleting a generated domain therefore removes its
appended route naturally, without a persisted managed-host list or deletion
tombstone. The old baseline's imported domains remain intact. Persisted deletion
authority is relevant only to explicitly authorized replacement/deletion of sites
that themselves exist in a baseline; that model is intentionally not wired here.

## TLS composition

Imported baseline local hosts remain in the mkcert SAN/managed hosts union even
when all Registry projects are deleted. TLS automation, existing certificate
loaders/entries, tags and HTTP connection policies remain unchanged. The new union
load_files entry inherits existing load_files tags to satisfy tagged certificate
selection. Existing certificate paths must remain readable by Caddy. Local
automation is still independently opt-in; configuring a base alone never invokes
mkcert or publishes hosts. No live Caddy application/deployment is done by tests.
