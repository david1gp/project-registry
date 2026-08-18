import type { IdentityDirectory } from "../identity/IdentityDirectory.js"
import type { PosixUserDirectory } from "../identity/PosixUserDirectory.js"
import type { Clock } from "../session/Clock.js"
import type { SessionCookieOptions } from "../session/SessionCookieOptions.js"
import type { SessionStore } from "../session/SessionStore.js"
import type { TokenReferenceStore } from "../session/TokenReferenceStore.js"
import type { LoginTransactionStore } from "./LoginTransactionStore.js"
import type { ZitadelHttp } from "./ZitadelHttp.js"
import type { ZitadelHttpOptions } from "./ZitadelHttpOptions.js"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"

export type ZitadelCallbackOptions = {
  config: ZitadelOidcConfig
  callbackUrl: string
  query: URLSearchParams
  cookieHeader: string | null | undefined
  http: ZitadelHttp
  transactions: LoginTransactionStore
  posixUsers: PosixUserDirectory
  identityDirectory: IdentityDirectory
  tokenReferences: TokenReferenceStore
  sessions: SessionStore
  clock?: Clock
  cookie?: SessionCookieOptions
  timeoutMs?: ZitadelHttpOptions["timeoutMs"]
  signal?: ZitadelHttpOptions["signal"]
  maxBodyBytes?: ZitadelHttpOptions["maxBodyBytes"]
}
