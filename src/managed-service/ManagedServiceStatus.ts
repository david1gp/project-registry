export type ManagedServiceStatus = {
  owner: string
  project: string
  service: string
  unit: string
  port: number
  domains: string[]
  autostart: boolean
  activeState: string
  subState: string
  unitFileState: string
  mainPid: number
}
