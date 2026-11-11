export type DevProjectFilesystem = {
  readFile(path: string): Promise<string>
  realpath(path: string): Promise<string>
  stat(path: string): Promise<{ isDirectory(): boolean }>
}
