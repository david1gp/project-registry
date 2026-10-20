# DNS lifecycle tracking

## Goal
Track managed Cloudflare DNS records and reconcile them on entry edits and deletions as well as creation.

## Decisions
- Keep only the existing global environment switch; no saved setting or settings UI.
- When enabled and credentials are available, edits upsert and durably track all current public domains before removing obsolete tracked records. Failed or partial replacements retain old records for retry, including after restart. Project deletion or removal of all public domains does not require server-IP discovery before cleanup.
- Revalidate the latest desired state before cleanup so concurrent edits and newly reclaimed hostnames cannot be deleted using an obsolete snapshot. Preserve shared-record ownership and external/private-domain safety.
- Persist managed record identities across restarts. Delete only verified tracked records, not arbitrary records discovered by name.
- Preserve background, nonfatal DNS behavior, creation opt-out, cancellation, and existing server-IP resolution. DNS-only permissions must suffice; unrelated zone-setting writes are not part of DNS reconciliation.
- Distinguish registry persistence from integration success in human CLI output. Expose DNS queue/error state alongside Caddy status and log credential-safe, structured failure/retry/recovery context without raw provider messages or bodies.
- Preserve unrelated working-tree changes and base implementation on the latest committed DNS fixes.

## Approach
Inspect the current committed runtime and repository mutation boundaries. Extend the DNS client and add durable tracking, then wire edit/delete lifecycle events and test ordering, restart recovery, opt-outs, and failures. Reuse existing dependencies and conventions.

## Tasks
1. Complete: identify committed integration points and minimal tracking design.
2. Complete: add verified delete-by-ID client and atomic daemon-local tracking storage with focused tests.
3. Complete: integrate tracked background reconciliation with edit/delete hooks, restart recovery, and documentation.
4. Complete: independently review and verify intended changes.
