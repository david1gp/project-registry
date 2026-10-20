export type ProjectRegistryCliCaddyOptions = {
  port?: number
  domains?: string[]
  path?: string
  kind?: "proxy" | "static"
  access?: "internal" | "external"
  networkVisibility?: "public" | "private"
  docs?: boolean
  browse?: boolean
  headerUp?: Record<string, string>
  disabled?: boolean
  spa?: boolean
  oidcPaths?: string[]
  flushInterval?: number
}
