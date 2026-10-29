# Phase 1 runbook: private-DNS bulk import on leo-servr

Executes on `leo-servr` as root unless noted. The registry-side code for
this phase is merged but `PROJECT_REGISTRY_PRIVATE_DNS_ENABLED` stays
unset until the import is proven. The `~/ds` manifest gate stays
authoritative for every not-yet-migrated scope until Phase 2.

## 0. Credential gate (read-only, tokens never printed)

For each owner token in `/etc/project-registry/cloudflare/{leo,david,fabian,musa}.env`,
probe zone visibility without mutating anything (same pattern as the
2026-10-20 audit, §9):

```bash
for owner in leo david fabian musa; do
  ( set -a; . /etc/project-registry/cloudflare/$owner.env; set +a
    for zone in wonder1.de david-siewert.com webflows.de covux-design.de; do
      echo "== $owner / $zone"
      curl -s -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
        "https://api.cloudflare.com/client/v4/zones?name=$zone" | head -c 300; echo
    done )
done
```

Required results before continuing:

- `leo.env` sees `wonder1.de` (already proven by the coding cutover).
- `david.env` sees `david-siewert.com`.
- `fabian.env` sees `webflows.de`, `musa.env` sees `covux-design.de`
  (needed for Phases 3–4 only; may lag Phase 1/2).

Missing scope means the owner mints a Zone-Read + DNS-Edit token and you
replace their file. No code involved.

## 1. Delete the two David strays

`presentation-example-1.leonardomora.de` and `preview.rift-command.com`
were approved for deletion. Remove their registry rows (or retire the
routes if the rows serve other domains), then confirm no Caddy route,
split-DNS entry, or resolver line references them:

```bash
bun run leo:tailscale:split-dns plan   # neither name may appear
project-registry status --json          # no lingering failures
```

## 2. Switch leo's default domain to wonder1.de

Registry code now rejects an injected default domain outside the owner's
zone, so a domain-less `leo` create fails until the default moves too.
Both layers, on `leo-servr`:

```bash
# a. installer default (repo file ops/migration/project-registryd.env is
#    already updated; mirror it into the live file):
#    PROJECT_REGISTRY_DEFAULT_USER_DOMAINS={"leo":"wonder1.de",...}

# b. stored per-owner decision (as leo, via the daemon CLI):
project-registry user default-domain get
project-registry user default-domain set wonder1.de
```

Verify: `project-registry project create --name probe-delete-me` as `leo`
without `--domain` must yield `probe-delete-me.wonder1.de` on a private
route. Delete the probe project afterwards.

## 3. Bulk import (desired state = registry private hostnames)

Cross-check the registry's private hostname set against the `~/ds`
manifest before converging anything:

```bash
project-registry status --json   # Cloudflare queue quiet, no failures
bun run leo:tailscale:split-dns plan      # owned FQDNs vs live map
bun run leo:tailscale:verify              # pre-import baseline
```

Converge with the existing `~/ds` apply path (one batch, one state file,
owner-only permissions), keeping resolver + split-DNS + private Caddy in
agreement. Retire no public record until its private replacement shows
trusted HTTPS. Keep transitional legacy aliases answerable until the app
cutover finishes.

## 4. Verify, then enable the registry reconciler

```bash
bun run leo:tailscale:verify
bun run leo:tailscale:runtime-verify status
project-registry status --json   # cloudflareDns quiet
```

Only then set `PROJECT_REGISTRY_PRIVATE_DNS_ENABLED=true` in the daemon
environment and restart the daemon. Expected: reconciler reports no drift
(desired == live). Any drift means the import and the registry disagree —
resolve by editing the registry (source of truth from here on), never by
hand-editing the resolver.

## 5. Rollback pointers (coordinated, never automatic)

- Split-DNS: per-batch `--state-file` restore.
- Resolver: `/var/lib/leo-tailscale-private-dns/<timestamp>/` snapshots.
- Registry: `project-registry project edit` back to the prior domains;
  Cloudflare reconciliation restores public records the same way.
- Never run generic resolver rollback while pilots are live: it stops the
  shared resolver for all private scopes.

## Exit criteria for Phase 2

Import state and registry agree with zero drift, verification green,
`leo` pilot self-serve (add/edit/delete one `wonder1.de` name, confirm
tailnet resolution + trusted cert + removal) succeeds. Then open
`wonder1.de` self-serve and stand down the manifest gate for that zone.
