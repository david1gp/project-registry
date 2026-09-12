export const projectRegistryCliHelp = `Usage: project-registry [--socket <path>] [--json] <command>

Commands:
  project list
  project get <name>
  project create [--name <name>] [--type <type>] [--service <id>] [--ownership <ownership>] [--domain <hostname>] [options]
  project edit <name> [--type <type>] [--service <id>] [--ownership <ownership>] [options]
  project delete <name>
  delete --port <port>
  project history <name> [--limit <n>]
  project access-logs <name> [--owner <owner>] [--limit <n>] [--before <cursor>]
  history [--limit <n>]
  docs <path> [--http]
  docs <name> <path> [--http]
  config [selector]
  regenerate
  status
  version             Show deployed backend and local CLI/library versions
  user default-domain get
  user default-domain set <domain>
  user default-domain unset
  user cloudflare-token set --token-stdin

Project create/edit options:
  --port <port>              Upstream port (create allocates one when omitted)
  --domain <hostname>        Domain; repeat to provide multiple domains; defaults to the configured user domain
  --path <path>              Static/docs filesystem path (defaults to the current directory)
  --name <name>              Project name (defaults to the path folder name)
  --type <own|internal|customer>
                              Project classification; edits preserve all services and Caddy settings
  --service <id>             Service of the project to create or edit (defaults to 'default');
                             sibling services keep their domains, port, and Caddy settings
  --ownership <registry|external>
                              Service ownership; omitted edits preserve the selected service's ownership
  --no-dns                    Skip automatic Cloudflare DNS reconciliation for this create
  --kind <proxy|static>      Caddy route kind
  --access <internal|external>
  --docs | --no-docs
  --browse | --no-browse
  --disabled | --enabled
  --spa | --no-spa
  --header-up <K=V>          Upstream header; repeat to provide multiple headers
  --label <KEY=VALUE>        Project label; repeat to provide multiple labels
  --remove-label <KEY>       Remove a project label; repeat (edit only)
  --clear-labels              Clear all project labels (edit only)
  --flush-interval <number>  Reverse proxy flush interval (-1 for immediate)

Cloudflare credentials:
  user cloudflare-token set --token-stdin
                              Read one token line from stdin; never pass it as an argument

Project names:
  Start with a lowercase letter or digit; use only lowercase letters, digits, and hyphens.

Options:
  --socket <path>  Unix socket (then PROJECT_REGISTRY_SOCKET, then /run/project-registry/$USER.sock)
  --json           Emit a stable JSON envelope
  -h, --help       Show help
  -V, --version    Show local CLI version without contacting the daemon
  --verbose        Include local executable and runtime metadata with --version
`
