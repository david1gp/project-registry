# Opt-in local domains wiring

Local automation is disabled by default in both root and user mode. Configure all
four variables explicitly to enable it:

```sh
PROJECT_REGISTRY_LOCAL_DOMAINS_ENABLED=true
PROJECT_REGISTRY_LOCAL_MKCERT_BINARY=/absolute/path/to/mkcert
PROJECT_REGISTRY_LOCAL_CERTIFICATES_STATE_DIRECTORY=/home/david/.local/state/project-registry/certificates
PROJECT_REGISTRY_LOCAL_HOSTS_FILE=/var/lib/project-registry-david/hosts
```

The enable flag accepts the daemon's boolean spellings: `1`, `true`, `yes`, `on`,
`auto`, `enabled`; or `0`, `false`, `no`, `off`, `never`, `disabled`. Omission means
disabled; an invalid or blank flag is rejected. The three paths are required
when enabled, must be absolute and normalized, and must not contain NUL bytes or
be `/`. Hosts output cannot be within `/etc`. No path defaults are inferred for
local automation, and supplying paths alone does not enable it.

The equivalent daemon configuration is an optional `localDomains` object:

```json
{
  "localDomains": {
    "mkcertBinary": "/absolute/path/to/mkcert",
    "stateDirectory": "/home/david/.local/state/project-registry/certificates",
    "hostsFilePath": "/var/lib/project-registry-david/hosts"
  }
}
```

The caller must provision a stable, system-readable, user-writable hosts output
directory and seed the output file with the existing non-Registry hosts entries.
That file is composed by the existing managed-block renderer/reconciler; it is
not a new baseline source. A privileged one-time `/etc/hosts` pointer setup is a
separate deployment step. Runtime never modifies `/etc` or invokes `mkcert
-install`; the daemon user's mkcert CA must already be trusted. Caddy must be
able to read the daemon user's private certificate directory (normally same-user
Caddy in user mode).

The common Caddy application generation boundary first merges an optional preserved
Caddy base, then derives normalized, deduplicated concrete DNS names from positive
host matchers in the merged active HTTP routes (including nested routes and every
server). Thus imported baseline local domains remain in the hosts/certificate union,
even when Services catalog metadata marks them externally owned. Without a base,
disabled, externally-owned and Cloudflare Pages entries are excluded by generation;
wildcard, IP, dynamic, invalid and single-label hosts are not provisioned. Opt-in
local automation assumes the active concrete hosts in this configuration are local.
It composes the certificate provisioner first, then the hosts reconciler, then
serializes, validates and loads Caddy. Startup, project creation/edit/deletion,
explicit regeneration and periodic application share this boundary.

The returned versioned certificate and key paths are embedded in the Caddy JSON
body at `apps.tls.certificates.load_files`, not passed as admin-load options. The
existing TLS app, automation, other certificate loaders and load_files entries are
retained. The new union certificate inherits the union of existing load_files tags
so imported `certificate_selection.any_tag` policies continue selecting it without
rewriting connection policies. Existing baseline files must remain readable; they
are not replaced or deleted by local automation.
The unchanged domain set reuses its versioned pair. Removing the final domain clears
the managed hosts entries without requesting an empty certificate, and generated
Caddy configuration contains no local TLS file loader. Older published
certificate files remain available for previously loaded configurations.

Issuance failure blocks hosts publication and Caddy validation/load. Hosts
publication failure also blocks Caddy validation/load. A later Caddy failure does
not roll back a successful hosts publication; the normal pending/retry status
tracks application failure. When local automation is enabled, daemon startup
always loads the reconciled configuration, even if
`PROJECT_REGISTRY_CADDY_INITIALIZE_FROM_GENERATED_CONFIG=true`; newly generated
paths cannot safely be assumed already loaded. When disabled, that initialization
setting retains its original behavior unless a preserved base is configured (which
also forces startup reconciliation/validation/load).
