import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { PosixUserDirectory } from "../identity/PosixUserDirectory.js"
import type { Clock } from "../session/Clock.js"
import type { SessionStore } from "../session/SessionStore.js"
import type { TokenReferenceStore } from "../session/TokenReferenceStore.js"

export type ProjectAccessCreateOptions = {
  identityDirectory: IdentityDirectory
  posixUsers: PosixUserDirectory
  transport:
    | {
        transport: "browser"
        sessionId: string
        sessions: SessionStore
        tokenReferences: TokenReferenceStore
        clock?: Clock
        timeoutMs?: number
        signal?: AbortSignal
      }
    | {
        transport: "unix"
        username: string
        accessToken: string
        timeoutMs?: number
        signal?: AbortSignal
      }
  timeoutMs?: number
  signal?: AbortSignal
}
