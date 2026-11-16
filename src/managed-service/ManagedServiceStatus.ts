export type ManagedServiceStatus = {
  owner: string
  project: string
  service: string
  unit: string
  /** Absent for background workers without a Caddy route. */
  port?: number
  domains: string[]
  autostart: boolean
  activeState: string
  subState: string
  unitFileState: string
  mainPid: number
}
