import type { CsrfTokenStore } from "./CsrfTokenStore.js"
import type { SessionCookieOptions } from "./SessionCookieOptions.js"
import type { TokenReferenceStore } from "./TokenReferenceStore.js"

export type SessionLogoutOptions = {
  cookie?: SessionCookieOptions
  csrf?: CsrfTokenStore
  csrfToken?: string
  tokenReferences?: TokenReferenceStore
  timeoutMs?: number
  signal?: AbortSignal
}
