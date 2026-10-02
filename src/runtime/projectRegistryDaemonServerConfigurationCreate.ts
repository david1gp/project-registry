import type { ProjectRegistryDaemonServerOptions } from "./ProjectRegistryDaemonServerOptions.js"

export function projectRegistryDaemonServerConfigurationCreate(
  options: ProjectRegistryDaemonServerOptions,
): Record<string, unknown> {
  // An ACL repair walks and verifies every entry. Bun's default 10-second
  // idle timeout applies to both HTTP and Unix requests awaiting a response.
  const values: Record<string, unknown> = {
    fetch: (request: Request, server: { timeout: (request: Request, seconds: number) => void }) => {
      if (request.method === "POST" && /^\/api\/v1\/users\/[^/]+\/projects\/[^/]+\/fix-acl$/.test(new URL(request.url).pathname)) {
        server.timeout(request, 0)
      }
      return options.fetch(request)
    }
  }
  if (options.unix !== undefined) {
    values.unix = options.unix
    return values
  }
  values.hostname = options.hostname
  values.port = options.port
  return values
}
