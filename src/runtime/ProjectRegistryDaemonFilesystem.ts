import type { ProjectRegistryDaemonFileStat } from "./ProjectRegistryDaemonFileStat.js"

export type ProjectRegistryDaemonFilesystem = {
  lstat(path: string): Promise<ProjectRegistryDaemonFileStat | undefined>
  realpath(path: string): Promise<string>
  mkdir(path: string, mode: number): Promise<void>
  readdir(path: string): Promise<readonly string[]>
  chmod(path: string, mode: number): Promise<void>
  chown(path: string, uid: number, gid: number): Promise<void>
  chmodNoFollow?(path: string, mode: number): Promise<void>
  chownNoFollow?(path: string, uid: number, gid: number): Promise<void>
  unlink(path: string): Promise<void>
}
