import type { ProjectRegistryCliCaddyOptions } from "./ProjectRegistryCliCaddyOptions.js"

export type ProjectRegistryCliInvocation = {
  command:
    | { kind: "help" }
    | { kind: "version" }
    | { kind: "user-default-domain-get" }
    | { kind: "user-default-domain-set"; domain: string }
    | { kind: "user-default-domain-unset" }
    | { kind: "project-list" }
    | { kind: "project-get"; name: string }
    | { kind: "project-create"; name?: string; caddy: ProjectRegistryCliCaddyOptions; labels?: Record<string, string> }
    | {
        kind: "project-edit"
        name: string
        caddy: ProjectRegistryCliCaddyOptions
        labels?: Record<string, string>
        removeLabels?: string[]
        clearLabels?: boolean
      }
    | { kind: "project-delete"; name: string }
    | { kind: "project-delete-by-port"; port: number }
    | { kind: "project-history"; name: string; limit?: number }
    | { kind: "project-access-logs"; name: string; owner?: string; limit?: number; before?: string }
    | { kind: "history"; limit?: number }
    | { kind: "docs"; name: string; path: string; http: boolean }
    | { kind: "docs-local"; path: string; http: boolean }
    | { kind: "config"; selector?: string }
    | { kind: "regenerate" }
    | { kind: "status" }
  json: boolean
  socket?: string
}
