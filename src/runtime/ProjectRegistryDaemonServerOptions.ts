export type ProjectRegistryDaemonServerOptions = {
  hostname?: string
  port?: number
  unix?: string
  fetch(request: Request): Response | Promise<Response>
}
