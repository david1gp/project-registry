export type ProjectRegistryDaemonServerIpFilesystem = {
  readFile(path: string): Promise<string>
  mkdir(path: string, mode: number): Promise<void>
  writeFile(path: string, value: string, mode: number): Promise<void>
  rename(source: string, destination: string): Promise<void>
  unlink(path: string): Promise<void>
}
