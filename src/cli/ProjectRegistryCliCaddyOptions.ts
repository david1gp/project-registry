export type ProjectRegistryCliCaddyOptions = {
  port?: number
  domains?: string[]
  path?: string
  kind?: "proxy" | "static"
  access?: "internal" | "external"
  docs?: boolean
  browse?: boolean
  headerUp?: Record<string, string>
  disabled?: boolean
  spa?: boolean
  flushInterval?: number
}
