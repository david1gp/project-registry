# Goal
Set up existing `leo@leo-server:~/projects/eventoren` using the default project-creator profile. The user explicitly authorizes recipe overwrites for this one-off Eventoren exception.

# Decisions
- Preserve dirty CLI checkouts; use a separate clean checkout of current upstream.
- Allow existing Eventoren files to be overwritten by the recipe; do not change global existing-project behavior. Retain the full pre-setup backup at `/home/leo/backups/eventoren/eventoren-20260913T161205Z.tar.zst`.
- Use the isolated CLI's explicit `--overwrite-existing` opt-in for this run; seed merges preserve unrelated files and `.git`, and default rejection of existing seed destinations remains unchanged.
- Pass all domains through CLI options and generate `.env.development` and `.env.production` through recipe steps.
- Development site/Convex/API: `https://eventoren.leonardomora.de`, `https://eventoren-convex.leonardomora.de`, `https://eventoren-api.leonardomora.de`.
- Production site/Convex/API: `https://eventoren.contentoren.de`, `https://eventoren-convex.contentoren.de`, `https://eventoren-api.contentoren.de`.
- Use targets library,web,webapp,backend,cli; section Eigene; public visibility; Convex backend; SSR; content,demos,www-redirect features; de,en languages; assets-service,cloudflare-pages,convex-self-hosted,prodctl,project-registry-docs,solid-ui capabilities.

# Approach
Prepare an isolated current CLI, implement and test missing domain/environment support, review existing-project changes, then execute with the authorized Eventoren overwrites and verify configuration.

# Tasks
1. Completed: prepare isolated upstream CLI checkout at `/home/leo/adaptive/project-creator-eventoren-task1` (upstream `218fe97683a5616f0d295a662b9aad0f5b657f29`). Use explicit `--profile default`.
2. Completed: implement and test explicit preview backend domains and recipe persistence of both environment files in the isolated checkout.
3. Completed: back up Eventoren and review the exact setup command and proposed changes. User authorizes the reviewed overwrite behavior for Eventoren only.
4. Completed: execute reviewed setup with authorized overwrites, verify all six saved environment URLs, set the existing GitHub repository public, and inspect production and development endpoints.
