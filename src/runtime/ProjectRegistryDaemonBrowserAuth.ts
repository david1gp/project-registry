import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { PosixUserDirectory } from "../identity/PosixUserDirectory.js"
import type { SessionCookieOptions } from "../session/SessionCookieOptions.js"
import type { SessionStore } from "../session/SessionStore.js"
import type { TokenReferenceStore } from "../session/TokenReferenceStore.js"

export type ProjectRegistryDaemonBrowserAuth = {
  sessions: SessionStore
  tokenReferences: TokenReferenceStore
  identityDirectory: IdentityDirectory
  posixUsers: PosixUserDirectory
  cookie?: SessionCookieOptions
  timeoutMs?: number
}
