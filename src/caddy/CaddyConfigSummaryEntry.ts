export type CaddyConfigSummaryEntry = {
  owner: string
  name: string
  port: number
  kind: "proxy" | "static"
  access: "internal" | "external"
  domains: string[]
}
