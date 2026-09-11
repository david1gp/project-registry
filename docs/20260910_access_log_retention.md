# Access log retention

## Goal
- Automatically retain at most 14 days of archived access logs and roughly 50 MiB per project, including existing logs.

## Decisions
- Keep Caddy rotation at 25 MiB, retain one compressed archive, and set age retention to 14 days.
- Periodically prune recognized archives at least 14 days old or exceeding a 50 MiB total budget including the active file; never delete or truncate Caddy's active file.
- Reuse existing reconciliation scheduling and filesystem safety conventions and existing libraries.

## Approach
- Centralize limits and add tested archive cleanup functions integrated with existing reconciliation.
- Preserve inactive-directory cleanup and stale-snapshot protections.
- Verify automated tests, then inspect and clean existing production archives if accessible using the implemented policy.

## Tasks
1. Implement retention constants, archive cleanup, integration, tests, and update existing policy documentation. Status: complete.
2. Independently verify scheduling and cleanup correctness and run relevant checks. Status: complete.
3. Inspect production access and apply cleanup to existing logs if available. Status: complete; updated daemon deployed and periodic cleanup verified.
