/**
 * Daemon configuration for registry-managed permanent services. `enabled`
 * false (the default) means the registry never writes, removes, or starts a
 * unit: reconcile is a no-op and the `svc` API answers `services.disabled`.
 */
export type ManagedServiceConfig = {
  enabled: boolean
  user: string
  group: string
  homeDirectory: string
  projectsRoot: string
  allowedUsers: readonly string[]
  slice: string
  unitDirectory: string
  pathValue: string
  auditLogPath: string
}
