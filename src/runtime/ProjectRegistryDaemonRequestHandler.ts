import type { ProjectRegistryDaemonRequestContext } from "./ProjectRegistryDaemonRequestContext.js"

export type ProjectRegistryDaemonRequestHandler = (
  request: Request,
  context: ProjectRegistryDaemonRequestContext,
) => Response | Promise<Response>
