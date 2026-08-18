import type { IdentityDirectory } from "./IdentityDirectory.js"
import type { PosixUserDirectory } from "./PosixUserDirectory.js"

export type VisibleUserDirectoryListOptions = {
  accessToken: string
  identityDirectory: IdentityDirectory
  posixUsers: PosixUserDirectory
  timeoutMs?: number
  signal?: AbortSignal
  maxUsers?: number
  maxLookupCount?: number
}
