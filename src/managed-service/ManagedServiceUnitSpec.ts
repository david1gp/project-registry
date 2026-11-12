export type ManagedServiceUnitSpec = {
  owner: string
  project: string
  service: string
  user: string
  group: string
  homeDirectory: string
  projectsRoot: string
  workingDirectory: string
  slice: string
  pathValue: string
  port: number
  domains: readonly string[]
  /** Absolute env file path; already validated to live inside the project dir. */
  envFile?: string
  /** Absolute executable path or a bare name resolved through the unit PATH. */
  command: string
  args: readonly string[]
}
