# Goal
Serve allgroups-chat docs only on its preview web service and default docs to disabled for new services.

# Decisions
- Keep preview UI source path and explicit docs enablement.
- Retire allgroups-chat.leonardomora.de by clearing the default service Caddy configuration, preserving unit metadata.
- Disable docs and clear source paths for API, Convex, and dashboard services.
- Preserve unrelated workspace changes and existing explicit docs settings for other projects.

# Approach
Update application defaults and focused tests, then use existing SSH and production update/deployment mechanisms. Verify routing, DNS retirement, and running units.

# Tasks
1. Complete: update docs defaults and focused tests; preserve explicit settings and migration compatibility.
2. Complete: deploy the verified defaults through the existing deployment process.
3. Complete: update authoritative allgroups-chat service configuration and verify live routes, DNS, preview docs configuration, and units.
