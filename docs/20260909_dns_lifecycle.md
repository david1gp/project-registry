# DNS lifecycle tracking

## Goal
Track managed Cloudflare DNS records and reconcile them on entry edits and deletions as well as creation.

## Decisions
- Keep only the existing global environment switch; no saved setting or settings UI.
- When enabled and credentials are available, edits upsert current domains and remove tracked records for removed domains; deletion removes tracked records.
- Persist managed record identities across restarts. Delete only verified tracked records, not arbitrary records discovered by name.
- Preserve background, nonfatal DNS behavior, creation opt-out, cancellation, and existing server-IP resolution.
- Preserve unrelated working-tree changes and base implementation on the latest committed DNS fixes.

## Approach
Inspect the current committed runtime and repository mutation boundaries. Extend the DNS client and add durable tracking, then wire edit/delete lifecycle events and test ordering, restart recovery, opt-outs, and failures. Reuse existing dependencies and conventions.

## Tasks
1. Complete: identify committed integration points and minimal tracking design.
2. Complete: add verified delete-by-ID client and atomic daemon-local tracking storage with focused tests.
3. Complete: integrate tracked background reconciliation with edit/delete hooks, restart recovery, and documentation.
4. Complete: independently review and verify intended changes.
