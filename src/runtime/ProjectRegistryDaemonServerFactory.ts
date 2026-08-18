import type { ProjectRegistryDaemonServer } from "./ProjectRegistryDaemonServer.js"
import type { ProjectRegistryDaemonServerOptions } from "./ProjectRegistryDaemonServerOptions.js"

export type ProjectRegistryDaemonServerFactory = (
  options: ProjectRegistryDaemonServerOptions,
) => ProjectRegistryDaemonServer | Promise<ProjectRegistryDaemonServer>
