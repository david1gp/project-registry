# Self-serve private (Tailscale) DNS in project-registry

Date: 2026-10-29. Status: plan, not implemented.

## Goal

Move the Tailscale private-DNS logic that currently lives in `~/ds`
(`dev-servers`, `leo-server/` scope manifest, dnsmasq resolver, split-DNS
control, private Caddy + TLS, retirement/verifier tooling) into
`project-registry`, so users can add/edit/delete their own private domains
with `project-registry project create/edit` and no manifest PR.

Non-goal: per-person visibility. A private name resolves tailnet-wide.
Narrower access stays manual Tailscale-admin ACL work.

## Decisions (settled 2026-10-29)

- One writer per zone, no crossing, no admin override:

  | Owner | Exclusive zone |
  |---|---|
  | `leo` | `wonder1.de` |
  | `david` | `david-siewert.com` |
  | `fabian` | `webflows.de` |
  | `musa` | `covux-design.de` |

- `presentation-example-1.leonardomora.de` and `preview.rift-command.com`
  (both David-tagged strays) are deleted, not imported.
- Apex records (`wonder1.de` bare) are never user-claimable.
- Wildcards (`*.wonder1.de`) stay forbidden. Every name is an exact FQDN.
- Future zones are not self-serve: code change + credential probe first.
- Audience is tailnet-wide for every private name. Confirmed.
- Multi-level names (`api.preview.sales.wonder1.de`) are supported, with
  per-host DNS-01 enrollment (no wildcard coverage beyond one level).
- Non-loopback upstream on a private route is a hard error with an
  explanatory message. Enforced for `leo` first (later `david`);
  `fabian`/`musa` do not use Tailscale yet and default to public, so the
  check cannot misfire on their routes.
- CLI success on a private domain prints a tailnet-DNS hint (browser DoH
  bypasses split-DNS; enable Tailscale DNS on the client).

## Current state

- Registry already has: per-route `networkVisibility` (private default for
  new `leo`/`david` routes,
  `src/project/projectNetworkVisibilityDefault.ts`), split public/private
  Caddy instances, DNS plan that excludes private names from Cloudflare
  (`src/project/projectDnsPlanCreate.ts`), and the Cloudflare reconciler as
  the async pattern to mirror
  (`src/runtime/projectRegistryDaemonCloudflareDnsCreate.ts`).
- `~/ds` owns: central scope manifest
  (`leo-server/tailscale-rollout/leoTailscalePrivateScopePolicy.ts`),
  dnsmasq exact-host resolver (`leo-server/tailscale/`), Tailscale split-DNS
  API control (`leo-server/tailscale-control/`, per-batch state files,
  root-only token), private Caddy + per-host TLS, retirement/verification.
- Credential files exist for all four owners in
  `/etc/project-registry/cloudflare/` (`leo/david/fabian/musa.env`,
  root-only). `leo.env` provably covers `wonder1.de` (coding cutover with
  trusted DNS-01 certs, 2026-10-24).
- Credential gate still to probe on `leo-servr` (read-only `/zones?name=`
  lookups, token never printed): does `david.env` cover
  `david-siewert.com`, `fabian.env` cover `webflows.de`, `musa.env` cover
  `covux-design.de`? Missing scope means the owner mints a Zone-Read +
  DNS-Edit token; no code involved.

## Design

1. Owner-zone policy module (`src/project/`, pure, tested): static
   owner-to-zones map, `zoneClaimValidate(owner, hostname)` returning the
   owning zone or a rejection naming the allowed zones. Apex and wildcard
   inputs are rejected here.
2. Claim check in create/edit paths (`projectCreate.ts`, `projectEdit.ts`,
   after `projectOwnerAuthorize`, before normalize): every requested private
   domain must be inside one of the actor's zones, unless the owner has no
   Tailscale zones and requests nothing private (public-only flow unchanged).
   Cross-zone attempts fail with allowed-zone list.
3. Loopback guard for private routes: upstream host must be loopback
   (`127.0.0.1`/`::1`/`localhost`) or the route port must be local-only;
   otherwise the planned formatted error explaining tailnet-wide exposure.
   Applies when `networkVisibility` resolves to private.
4. Daemon private-DNS reconciler, mirroring the Cloudflare one: desired set
   = registry private hostnames; converges dnsmasq exact-host config +
   Tailscale split-DNS PATCH (owned FQDNs only, per-owner state files,
   shared-config atomic rewrite, never partial per-user overwrites);
   create-before-delete; defer-and-retry with backoff; `status`/`status
   --json` diagnostics in the same shape as `cloudflareDns`.
5. Per-owner TLS enrollment: private-Caddy DNS-01 uses the claiming
   owner's token (today always `leo.env`), public resolvers for challenges,
   never the private listener.
6. Deletion releases the name within the same owner's zone (single writer,
   so no hijack window). No grace period.

## Sequencing

- Phase 1, admin bulk import (root on `leo-servr`, one window): desired
  state from registry private routes cross-checked against the `~/ds`
  manifest; converge resolver + split-DNS + TLS; retire nothing public
  until its private replacement shows trusted HTTPS; delete the two David
  strays; keep transitional legacy aliases until app cutover. Manifest gate
  stays authoritative for not-yet-migrated scopes; never two writers per
  name.
- Phase 2, `leo` self-serve on `wonder1.de` (pilot).
- Phase 3, `david` self-serve on `david-siewert.com` (import near no-op).
- Phase 4, `fabian`/`musa` when they join the tailnet.

## Acceptance

- `leo` adds `checkout.wonder1.de` private: resolves on tailnet with DNS
  enabled, trusted cert (single-level via wildcard, multi-level via
  per-host enrollment), private Caddy serves, no public record created.
- `fabian` claiming `x.wonder1.de` fails naming `webflows.de`.
- Private route with LAN upstream fails with the explanatory error.
- `status --json` reports private-DNS queue/failures; key expiry defers
  with retry, same as Cloudflare path.
- Regen + both Caddy reloads preserve routing; restart recovery retains
  old records until replacements persist.
