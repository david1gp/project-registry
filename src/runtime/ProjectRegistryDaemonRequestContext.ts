import type { ProjectAccess } from "../access/ProjectAccess.js"

export type ProjectRegistryDaemonRequestContext =
  | {
      transport: "http"
      username?: string
      access?: ProjectAccess
    }
  | {
      transport: "unix"
      username: string
    }
