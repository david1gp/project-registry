/**
 * Filesystem seam for unit files and the audit log. Tests inject an in-memory
 * fake; production writes atomically (temp file + rename).
 */
export type ManagedServiceFilesystem = {
  list(directory: string): Promise<string[]>
  /** Undefined when the file does not exist. */
  read(path: string): Promise<string | undefined>
  writeAtomic(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
  append(path: string, content: string): Promise<void>
}
