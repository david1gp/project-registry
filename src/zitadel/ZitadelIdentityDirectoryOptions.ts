import type { ZitadelHttp } from "./ZitadelHttp.js"

export type ZitadelIdentityDirectoryOptions = {
  http: ZitadelHttp
  issuer: string
  orgId: string
  projectId: string
  timeoutMs?: number
  maxBodyBytes?: number
  maxResults?: number
}
