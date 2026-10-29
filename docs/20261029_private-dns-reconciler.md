# Private-DNS reconciler (Tailscale self-serve track)

Date: 2026-10-29. Status: implemented, disabled by default.

Companion to [the self-serve plan](20261029_tailscale-private-dns-selfserve.md):
this is the reconciler track (design item 4 + the TLS token seam from item 5).
The validation track (items 1-3) landed separately and is not modified here.

## Enable flag

`PROJECT_REGISTRY_PRIVATE_DNS_ENABLED=true` (`"1"/"true"/"yes"/"on"` also work).
Default is **disabled**: the queue stays idle, writes nothing, and `status`
reports `Private DNS: disabled`. Enable only for the Phase 1 admin bulk import
window on `leo-servr`, after the desired registry state is cross-checked
against the `~/ds` scope manifest.

## Config surface

| Env                                            | Config                            | Default                                      |
| ---------------------------------------------- | --------------------------------- | -------------------------------------------- |
| `PROJECT_REGISTRY_PRIVATE_DNS_ENABLED`         | `privateDns.enabled`              | `false`                                      |
| `PROJECT_REGISTRY_PRIVATE_DNS_TAILNET`         | `privateDns.tailnet`              | (required when enabled)                      |
| `PROJECT_REGISTRY_PRIVATE_DNS_NODE_ADDRESS`    | `privateDns.nodeAddress`          | (required when enabled, IPv4)                |
| `PROJECT_REGISTRY_PRIVATE_DNS_API_BASE`        | `privateDns.apiBaseUrl`           | `https://api.tailscale.com/api/v2`           |
| `PROJECT_REGISTRY_PRIVATE_DNS_DNSMASQ_CONFIG`  | `privateDns.dnsmasqConfigPath`    | `/etc/project-registry/private-dnsmasq.conf` |
| `PROJECT_REGISTRY_PRIVATE_DNS_RESOLVER_UNIT`   | `privateDns.resolverUnit`         | `leo-tailscale-private-dns`                  |
| `PROJECT_REGISTRY_PRIVATE_DNS_UPSTREAMS`       | `privateDns.upstreamResolvers`    | `1.1.1.1,8.8.8.8` (comma-separated)          |
| `PROJECT_REGISTRY_PRIVATE_DNS_CREDENTIALS_DIR` | `privateDns.credentialsDirectory` | `/etc/project-registry/tailscale`            |

Supporting files:

- Credentials: `<credentialsDirectory>/tailscale.env` (root-only) with
  `TAILSCALE_API_KEY=` (or `TAILSCALE_ACCESS_TOKEN=`). Tailnet-wide token held
  by the daemon; hot-reloaded, never logged.
- Tracking: `<serverIpCachePath>.private-dns.json`, next to the Cloudflare
  tracking file. Per-host entries carry owner, zone, node address, and
  claiming projects, plus the hash of the last resolver config confirmed
  loaded.
- Per-owner split-DNS rollback state: `<owner>.split-dns.json` next to the
  tracking file (same directory as the server-IP cache). Written before every
  PATCH; restorable with `tailscaleSplitDnsRollback`.
- dnsmasq config: `privateDns.dnsmasqConfigPath`, rewritten atomically and
  applied via `systemctl restart <resolverUnit>` (dnsmasq does not re-read its
  conf file on reload; only a restart applies it). The unit's `--conf-file`
  must point at this path.

## Behavior

- Desired set = registry private hostnames (enabled routes only; disabled,
  public, external-service, and Cloudflare-Pages names excluded), each
  validated against the owner-zone policy. Cross-zone/apex/wildcard claims
  never converge and surface as persistent `claim` errors naming the allowed
  zones.
- Converges split-DNS (owned exact FQDNs only, PATCH merge, never PUT) and the
  dnsmasq exact-host config with create-before-delete: replacements apply and
  persist before old entries are cleared.
- Defer-and-retry with backoff for missing credentials, key expiry (401/403),
  rate limits, tracking/resolver failures; same shape as `cloudflareDns` in
  `status` / `status --json` under the `privateDns` key, with owner-scoped
  error filtering.
- Guarantees: credentials and raw API bodies never logged; unrelated
  split-DNS entries, global resolvers, and MagicDNS untouched; removals refuse
  drifted/foreign-owned entries; the renderer emits per-host lines only and
  can never widen to whole-zone overrides.

## TLS enrollment seam

`projectPrivateTlsTokenOwnerSelect` / `projectPrivateTlsTokenResolve`
(`src/project/projectPrivateTlsTokenSelect.ts`) select the claiming owner's
Cloudflare credential for private-Caddy DNS-01 instead of always `leo.env`.
The claim is validated first; rejected claims resolve nothing.

## Explicit follow-ups (not in this track)

- Full private-Caddy TLS enrollment flow: per-host DNS-01 blocks using the
  seam above, public resolvers for challenges (never the private listener),
  single-level wildcard vs multi-level per-host enrollment.
- Phase 1 admin bulk import procedure (root on `leo-servr`): cross-check,
  converge, retire-nothing-public-until-trusted-HTTPS, delete the two David
  strays, transitional legacy aliases.
- Rollback CLI/Admin entry point around `tailscaleSplitDnsRollback` and the
  per-owner state files.
- Credential-scope probes for `david`/`fabian`/`musa` Cloudflare tokens.

## Follow-up status (2026-10-29)

- TLS enrollment core landed: `projectPrivateTlsEnrollmentPlanCreate` /
  `projectPrivateTlsEnrollmentPrepare`
  (`src/project/projectPrivateTlsEnrollment.ts`) classify single-level names
  as wildcard-covered (no enrollment, no credential lookup) and multi-level
  names as per-host DNS-01 with the claiming owner's token via the seam
  above; challenge resolvers default to public `1.1.1.1,8.8.8.8` and refuse
  the private listener. `projectRegistryDaemonPrivateTlsCreate`
  (`src/runtime/`) tracks enrollment readiness with the same
  start/shutdown/status/hooks lifecycle as this reconciler.
- Still open on TLS: rendering the enrollment set into the private-Caddy
  `tls.automation` section (per-zone DNS-01 issuer policies plus the
  `certificates.automate` loader), the atomic baseline install, regenerate
  settle, and the trusted-TLS gate (the `~/ds` `leoBatchTlsPrepare` steps);
  `caddyConfigGenerate` emits no `tls` section today. The tracker is also
  not yet wired into `projectRegistryDaemonCreate` or `status` output.
- Rollback CLI landed: `project-registry tailscale split-dns rollback
  (--state-file <path> | --owner <owner> --state-dir <dir>)`, a local admin
  command (no daemon round-trip) around `tailscaleSplitDnsRollback` with
  the same refusals (tailnet mismatch, externally changed entries). Auth
  from `TAILSCALE_TAILNET` + `TAILSCALE_API_KEY`/`TAILSCALE_ACCESS_TOKEN`,
  optional `TAILSCALE_API_BASE`. State files and credentials are root-only,
  so run it as root.
