import type { ManagedServiceAction } from "./ManagedServiceAction.js"

export type ManagedServiceAuditRecord = {
  at: string
  actor: string
  action: ManagedServiceAction
  owner: string
  project: string
  service: string
  unit: string
  success: boolean
  error?: string
}
