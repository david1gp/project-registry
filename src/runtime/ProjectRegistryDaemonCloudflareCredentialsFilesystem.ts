import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"

export type ProjectRegistryDaemonCloudflareCredentialsFilesystem = {
  lstat(path: string): Promise<ProjectRegistryDaemonFileStat | undefined>
  realpath(path: string): Promise<string>
  readFile(path: string): Promise<string>
  mkdir?(path: string, mode: number): Promise<void>
  chmod?(path: string, mode: number): Promise<void>
  writeFile?(path: string, value: string, mode: number): Promise<void>
  rename?(source: string, destination: string): Promise<void>
  unlink?(path: string): Promise<void>
}
