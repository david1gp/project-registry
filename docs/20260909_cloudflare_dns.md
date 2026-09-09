# Automatic Cloudflare DNS

## Goal
Automatically create or update Cloudflare DNS records from project lifecycle changes, using the daemon's resolved server IP, and remove only tracked records. Deploy and verify with disposable domains, then remove test resources.

## Decisions
- Server-side integration covers API and CLI creation.
- Enable automatically when a Cloudflare API token is configured; support server configuration disable and per-create `--no-dns`.
- Use the current server IP for A/AAAA records and exact domain matching; discover the longest matching accessible zone.
- DNS runs after successful persistence, without blocking entry creation. Queue work while initial IP discovery is pending.
- Create missing records, update matching records, skip identical records, and report incompatible record conflicts.
- Use existing dependencies and native fetch. Never log credentials.
- Persist managed record identities daemon-locally; edits remove tracked removed domains and deletes remove tracked records.

## Approach
Implement a tested Cloudflare client, then integrate a daemon-owned background reconciler with creation requests and configuration. Bound network requests and cancel background work on shutdown. Preserve unrelated worktree changes. Deploy only committed intended changes.

Managed record tracking is daemon-local and stored atomically at
`<PROJECT_REGISTRY_SERVER_IP_CACHE_PATH>.cloudflare-dns.json`, beside (not inside)
the configured server-IP cache and repository. Deletion verifies the tracked record's
current contents before deleting by its stored Cloudflare ID; changed or unknown records
are left untouched. Network, tracking, and reconciliation failures remain background
failures and do not change successful project mutation responses.

## Tasks
1. Complete: implement and test Cloudflare record reconciliation module (`cloudflareDnsReconcile`).
2. Complete: integrate daemon lifecycle, creation API, CLI opt-out, environment configuration, installer and documentation; test pending-IP and nonfatal failure behavior.
3. Complete: independent review and focused verification, then commit/push using commits skill.
4. Complete: deploy to this machine, verify automatic DNS and opt-out with disposable entries/domains, and remove all test resources.
