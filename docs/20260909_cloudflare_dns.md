# Automatic Cloudflare DNS

## Goal
Automatically create or update Cloudflare DNS records when an entry is created, using the daemon's resolved server IP. Deploy and verify with disposable domains, then remove test resources.

## Decisions
- Server-side integration covers API and CLI creation.
- Enable automatically when a Cloudflare API token is configured; support server configuration disable and per-create `--no-dns`.
- Use the current server IP for A/AAAA records and exact domain matching; discover the longest matching accessible zone.
- DNS runs after successful persistence, without blocking entry creation. Queue work while initial IP discovery is pending.
- Create missing records, update matching records, skip identical records, and report incompatible record conflicts.
- Use existing dependencies and native fetch. Never log credentials.
- No automatic DNS deletion or general edit synchronization in this change; explicitly clean up test records.

## Approach
Implement a tested Cloudflare client, then integrate a daemon-owned background reconciler with creation requests and configuration. Bound network requests and cancel background work on shutdown. Preserve unrelated worktree changes. Deploy only committed intended changes.

## Tasks
1. Complete: implement and test Cloudflare record reconciliation module (`cloudflareDnsReconcile`).
2. Complete: integrate daemon lifecycle, creation API, CLI opt-out, environment configuration, installer and documentation; test pending-IP and nonfatal failure behavior.
3. In progress: independent review and focused verification, then commit/push using commits skill.
4. Pending: deploy to this machine, verify automatic DNS and opt-out with disposable entries/domains, and remove all test resources.
