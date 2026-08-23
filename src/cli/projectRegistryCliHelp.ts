export const projectRegistryCliHelp = `Usage: project-registry [--socket <path>] [--json] <command>

Commands:
  project list
  project get <name>
  project create --name <name> --domain <hostname> [options]
  project edit <name> [options]
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

Project create/edit options:
  --port <port>              Upstream port (create allocates one when omitted)
  --domain <hostname>        Domain; repeat to provide multiple domains
  --path <path>              Static/docs filesystem path
  --kind <proxy|static>      Caddy route kind
  --access <internal|external>
  --docs | --no-docs
  --browse | --no-browse
  --disabled | --enabled
  --spa | --no-spa
  --header-up <K=V>          Upstream header; repeat to provide multiple headers
  --flush-interval <number>  Reverse proxy flush interval (-1 for immediate)

Options:
  --socket <path>  Unix socket (then PROJECT_REGISTRY_SOCKET, then /run/project-registry/$USER.sock)
  --json           Emit a stable JSON envelope
  -h, --help       Show help
  -V, --version    Show version
`
