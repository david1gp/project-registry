import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { PosixUserDirectory } from "../identity/PosixUserDirectory.js"
import type { Clock } from "./Clock.js"
import type { SessionStore } from "./SessionStore.js"
import type { TokenReferenceStore } from "./TokenReferenceStore.js"

export type SessionActorResolveOptions = {
  sessions: SessionStore
  tokenReferences: TokenReferenceStore
  identityDirectory: IdentityDirectory
  posixUsers: PosixUserDirectory
  clock?: Clock
  timeoutMs?: number
  signal?: AbortSignal
}
