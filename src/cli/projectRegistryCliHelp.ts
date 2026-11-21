export const projectRegistryCliHelp = `Usage: project-registry [--socket <path>] [--json] <command>

Commands:
  project list [--owner <owner>] [--section <name>] [--metadata <KEY[=VALUE]>]
  project get <name> [--owner <owner>]
  project create [--owner <owner>] [--name <name>] [--service <id>] [--ownership <ownership>] [--domain <hostname>] [options]
  project edit <name> [--owner <owner>] [--service <id>] [--ownership <ownership>] [options]
  project delete <name> [--service <id>] [--owner <owner>]
  project move <name> --owner <from> --to-owner <to> [--source-path-rewrite <fromPrefix>=<toPrefix>]
  project fix-acl <name>
  delete --port <port>
  project history <name> [--owner <owner>] [--limit <n>]
  project access-logs <name> [--owner <owner>] [--limit <n>] [--before <cursor>]
  project route-check <name> [--service <id>]
  history [--limit <n>]
  docs <path> [--http] [--owner <owner>]
  docs <name> <path> [--http]
  docs <path> publishes local Markdown to the owner selected by --owner, cwd config rules, or $USER
  docs <name> <path> requests docs from the explicitly named project
  In-cwd relative paths keep normalized hierarchy; absolute or outside-cwd paths publish by basename.
  Page paths allow only route-safe ASCII letters, digits, ., _, -, and /; index.md is reserved.
  Reusing a page path updates it within the owner's docs space.
  config [selector]
  regenerate
  status
  version             Show deployed backend and local CLI/library versions
  user default-domain get
  user default-domain set <domain>
  user default-domain unset
  user cloudflare-token set --token-stdin
  tailscale split-dns rollback (--state-file <path> | --owner <owner> --state-dir <dir>)
  dev up <project> [--root <path>] [--service <id>] [--ttl <ms>]
  dev down <project>
  dev ls
  svc status|start|stop|restart|enable|disable <project> [--service <id>]
  svc logs <project> [--service <id>] [-n <lines>] [-f]

Project create/edit options:
  --port <port>              Upstream port (create allocates one when omitted)
  --domain <hostname>        Domain; repeat to provide multiple domains; defaults to the configured user domain
  --path <path>              Static/docs filesystem path (defaults to the current directory)
  --name <name>              Project name (defaults to the path folder name)
  --service <id>             Service of the project to create, edit or delete (create defaults to 'default');
                             sibling services keep their domains, port, and Caddy settings
  --ownership <registry|external>
                              Service ownership; omitted edits preserve the selected service's ownership
  --no-dns                    Skip automatic Cloudflare DNS reconciliation for this create
  --kind <proxy|static>      Caddy route kind
  --access <internal|external>
  --network-visibility <public|private>
  --docs | --no-docs
  --browse | --no-browse
  --disabled | --enabled
  --spa | --no-spa
  --header-up <K=V>          Upstream header; repeat to provide multiple headers
  --oidc-path <pattern>        OIDC-protected path (Caddy matcher); repeat to protect multiple paths
  --clear-oidc-paths          Clear all OIDC-protected paths (edit only; cannot combine with --oidc-path)
  --label <KEY=VALUE>        Project label; repeat to provide multiple labels
  --remove-label <KEY>       Remove a project label; repeat (edit only)
  --clear-labels              Clear all project labels (edit only)
  --dev-command "<argv>"     Service dev command override with {port}/{host} placeholders (edit with --service)
  --clear-dev-command        Remove the service dev command override (edit with --service)
  --service-command "<argv>" Managed service command with {port}/{host} (edit with --service); default derives
                              from the package.json dev script on the service port; on a new --service
                              id it adds a background worker with no port or domain
  --clear-service-command    Remove the managed service command (edit with --service)
  --service-env-file <rel>   Managed service env file relative to the project directory (edit with --service)
  --clear-service-env-file   Remove the managed service env file (edit with --service)
  --service-container <podman>
                              Run the managed service command ('podman run …') as a rootless container of the
                              service user (edit with --service); the unit adds --rm --replace --name and stop
  --clear-service-container  Run the managed service command directly again (edit with --service)
  --autostart | --no-autostart
                              Enable/disable the managed service at boot; required for the first definition
  --flush-interval <number>  Reverse proxy flush interval (-1 for immediate)

Cloudflare credentials:
  user cloudflare-token set --token-stdin
                              Read one token line from stdin; never pass it as an argument

Dev servers (dark-gated; the daemon needs PROJECT_REGISTRY_DEV_ENABLED=true):
  dev up <project> [--root <path>] [--service <id>] [--ttl <ms>]
                              Start an on-demand dev server for <root>/<project>; prints DEV_URL for e2e use.
                              Command: service dev.command, else the package.json dev script (vite/rsbuild/
                              next/astro run directly on the lease port), else 'bun run dev' with PORT/HOST.
                              The server gets its own leased port and domain (<user>-<project>.wonder1.de)
                              and reads .env.development; it never takes the preview port, so never run
                              'bun run dev' on the preview port by hand.
  dev down <project>            Stop the on-demand dev server
  dev ls                        List on-demand dev servers
  --ttl <ms>                    Dev server lifetime in milliseconds up to 86400000 (dev up only)
  --root <path>                 Dev root to use when <project> exists in several allowed roots (dev up only)
  --service <id>                Registry service whose dev.command to run (dev up only)

Managed services (dark-gated; the daemon needs PROJECT_REGISTRY_SERVICES_ENABLED=true):
  Registry-owned system units proj-<project>-<service>.service run as the service user with the
  service's registry port. Allowed for the configured operators on every managed project.
  The *.wonder1.de preview is a production build: 'bun run preview:start' with the service
  env file '.env.preview' (projects not yet migrated still run their dev script). Refresh it with 'bun run preview:deploy', which restarts the unit
  via 'project-registry svc restart'.
  svc status <project> [--service <id>]     Show unit state for one or all managed services
  svc start|stop|restart <project> [--service <id>]
  svc enable|disable <project> [--service <id>]
                              Mutating actions are recorded in the managed-service audit log
  svc logs <project> [--service <id>] [-n <lines>] [-f]
                              journalctl output (default 100 lines, max 10000); -f follows

Split-DNS rollback (local admin command, no daemon round-trip):
  tailscale split-dns rollback --state-file <path>
  tailscale split-dns rollback --owner <owner> --state-dir <dir>
                              Restore owned split-DNS entries from a per-owner state file;
                              refuses on tailnet mismatch or externally changed entries.
                              Auth from TAILSCALE_TAILNET and TAILSCALE_API_KEY
                              (or TAILSCALE_ACCESS_TOKEN); optional TAILSCALE_API_BASE.

Project names:
  Start with a lowercase letter or digit; use only lowercase letters, digits, and hyphens.

Project list filters:
  --section <name>           Filter projects by section name (case-insensitive)
  --metadata <KEY[=VALUE]>   Filter by metadata/label key or key=value; repeat or comma-separate

Options:
  --socket <path>  Unix socket (then PROJECT_REGISTRY_SOCKET, then /run/project-registry/$USER.sock)
  --json           Emit a stable JSON envelope
  -h, --help       Show help
  -V, --version    Show local CLI version without contacting the daemon
  --verbose        Include local executable and runtime metadata with --version
`
