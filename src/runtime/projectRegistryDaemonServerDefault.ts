import type { ProjectRegistryDaemonServer } from "./ProjectRegistryDaemonServer.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import type { ProjectRegistryDaemonServerOptions } from "./ProjectRegistryDaemonServerOptions.js"

function serverOptions(options: ProjectRegistryDaemonServerOptions): Record<string, unknown> {
  const values: Record<string, unknown> = { fetch: options.fetch }
  if (options.unix !== undefined) {
    values.unix = options.unix
  } else {
    values.hostname = options.hostname
    values.port = options.port
  }
  return values
}

export function projectRegistryDaemonServerDefault(): ProjectRegistryDaemonServerFactory {
  return (options) => {
    const bun = globalThis.Bun
    if (typeof bun?.serve !== "function") throw new Error("Bun server API is unavailable")
    return bun.serve(
      serverOptions(options) as unknown as Parameters<typeof Bun.serve>[0],
    ) as unknown as ProjectRegistryDaemonServer
  }
}
