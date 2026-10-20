# Automatic Cloudflare DNS

## Goal
Automatically create or update Cloudflare DNS records from project lifecycle changes, using the daemon's resolved server IP, and remove only tracked records. Deploy and verify with disposable domains, then remove test resources.

## Decisions
- Server-side integration covers API and CLI creation.
- Enable by default, with `PROJECT_REGISTRY_CLOUDFLARE_DNS_ENABLED=false` as the explicit server-level disable switch, and support per-create `--no-dns`.
- Resolve credentials by project owner from `/etc/project-registry/cloudflare/{owner}.env`, or from the directory configured by `PROJECT_REGISTRY_CLOUDFLARE_CREDENTIALS_DIR`; do not fall back to global token environment variables.
- Use the current server IP for A/AAAA records and exact domain matching; discover the longest matching accessible zone.
- DNS runs after successful persistence, without blocking entry creation. Queue work while initial IP discovery is pending.
- Create missing records, update matching records, skip identical records, and report incompatible record conflicts. Managed A/AAAA records are DNS-only (`proxied: false`); existing proxied records are updated to DNS-only during reconciliation.
- Use existing dependencies and native fetch. Parse owner credential files without executing them, and never log credentials.
- Persist managed record identities daemon-locally. On edits, reconcile and persist all replacement public records before removing obsolete tracked records; partial failure retains old records for retry and restart recovery. Project deletion and edits with no remaining public domains may retire records without server-IP discovery.
- DNS reconciliation is DNS-only: resolve the zone, read records, and create/update the desired A/AAAA record. Tokens need Zone Read and DNS Edit for the intended zones, not Zone Settings or Zaraz permissions. Email obfuscation and Zaraz configuration are separate administrator concerns and are no longer changed automatically by the DNS client.
- Expose DNS operational state additively as `cloudflareDns` in `GET /api/v1/caddy/status` and in `project-registry status` (including JSON), without coupling daemon readiness to Cloudflare. Registry mutation success is explicitly distinguished from asynchronous DNS success.
- Log structured operation/outcome, project and hostname context, retry information, and HTTP status/numeric Cloudflare error code when available. Never retain upstream error messages or raw bodies, tokens, authorization headers, credential contents, or Zaraz variable values. Log state transitions rather than unchanged-success scan noise.

Owner credential files use `CLOUDFLARE_API_TOKEN` or its `CF_API_TOKEN` alias. The preferred name wins when both are
present. Missing credentials defer create, edit, reconciliation, and deletion work for retry; pending deletions retain
their recorded owner and are not performed when ownership is ambiguous.

## Approach
Implement a tested Cloudflare client, then integrate a daemon-owned background reconciler with creation requests and configuration. Bound network requests and cancel background work on shutdown. Preserve unrelated worktree changes. Deploy only committed intended changes.

Managed record tracking is daemon-local and is stored atomically at
`<PROJECT_REGISTRY_SERVER_IP_CACHE_PATH>.cloudflare-dns.json`, beside (not inside)
the configured server-IP cache and repository.

## Credential update interfaces

Users update only their authenticated owner's credential through the CLI or API. The CLI reads one token line from
stdin and does not accept a token flag or positional secret:

```bash
secret-manager cloudflare-token | project-registry user cloudflare-token set --token-stdin
```

Global `--json` and `--socket <path>` options remain supported. Success is concise human output
`updated cloudflare-token`, or the safe JSON envelope `{ "success": true, "data": { "updated": true } }`.

The API operation is:

```text
PUT /api/v1/users/{owner}/cloudflare-token
{ "token": "<token supplied in the request body>" }
```

The response is `{ "success": true, "data": { "updated": true } }`. There is no token get/list endpoint. The
authenticated HTTP session or Unix-socket actor is checked against `{owner}` before the root-managed file is written;
the owner route is not a client-controlled authorization override. A token update does not immediately reconcile DNS;
the next DNS operation reads the updated credential.

The public library exports
`projectRegistryDaemonCloudflareCredentialsCreate({ directory, filesystem })`, whose result exposes
`tokenSet(owner, token): PromiseResult<{ updated: true }>` and `tokenResolve(owner)`. This factory is a privileged
daemon-side filesystem component for root-managed credential files, not an arbitrary user's direct access path. Normal
users should use the authenticated CLI or API. The default filesystem adapter is
`projectRegistryDaemonCloudflareCredentialsFilesystemDefault()`.

## Public/private desired-host separation

- Desired-host ownership is split into public, private, and protected hostnames by the pure plan
  `projectDnsPlanCreate(projects)`. It preserves external-service and `pages.dev` protection: those
  hostnames stay protected and are never created, updated, or deleted by the daemon.
- A Caddy entry selects visibility through `caddy.networkVisibility: "public" | "private"`. An absent
  value treats the entry as public, so existing projects reconcile exactly as before.
- The existing public reconcile path receives public hostnames only. Private hostnames never reach the
  Cloudflare record API, and no Tailscale address is ever published to public DNS.
- A tracked public record whose hostname becomes private retires through the existing verified delete
  path (single-owner scheduling, owner credential, retry). It is never silently released like an
  external-service or `pages.dev` transition, and never left behind without deletion.
- The same normalized hostname claimed public by one entry/project and private by another is a conflict.
  The plan rejects it, the daemon reports a `conflicting-public-private-claims` DNS failure without any
  DNS writes, and retries with backoff until the claims agree. Ambiguous multi-owner tracked records keep
  the existing deferral: no deletion without a single recorded owner, and missing credentials defer and retry.
  Restart recovery must preserve old records until the surviving project's replacement public records succeed.
- Untracked records stay explicit infrastructure cleanup: the daemon never auto-deletes a record it did
  not track. Project and documentation URL generation is unchanged.

## Tasks

1. Complete: implement and test Cloudflare record reconciliation module (`cloudflareDnsReconcile`).
2. Complete: integrate daemon lifecycle, creation API, CLI opt-out, environment configuration, installer and documentation; test pending-IP and nonfatal failure behavior.
3. Complete: independent review and focused verification, then commit/push using commits skill.
4. Complete: deploy to this machine, verify automatic DNS and opt-out with disposable entries/domains, and remove all test resources.
