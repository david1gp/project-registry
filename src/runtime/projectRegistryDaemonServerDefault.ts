import type { ProjectRegistryDaemonServer } from "./ProjectRegistryDaemonServer.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import { projectRegistryDaemonServerConfigurationCreate } from "./projectRegistryDaemonServerConfigurationCreate.js"

export function projectRegistryDaemonServerDefault(): ProjectRegistryDaemonServerFactory {
  return (options) => {
    const bun = globalThis.Bun
    if (typeof bun?.serve !== "function") throw new Error("Bun server API is unavailable")
    return bun.serve(
      projectRegistryDaemonServerConfigurationCreate(options) as unknown as Parameters<typeof Bun.serve>[0],
    ) as unknown as ProjectRegistryDaemonServer
  }
}
