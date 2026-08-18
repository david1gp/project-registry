import type { Clock } from "../session/Clock.js"
import type { RandomBytes } from "../session/RandomBytes.js"
import type { LoginTransactionStore } from "./LoginTransactionStore.js"
import type { ZitadelHttp } from "./ZitadelHttp.js"
import type { ZitadelHttpOptions } from "./ZitadelHttpOptions.js"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"

export type ZitadelLoginStartOptions = {
  config: ZitadelOidcConfig
  http: ZitadelHttp
  transactions: LoginTransactionStore
  clock?: Clock
  randomBytes?: RandomBytes
  timeoutMs?: ZitadelHttpOptions["timeoutMs"]
  signal?: ZitadelHttpOptions["signal"]
  maxBodyBytes?: ZitadelHttpOptions["maxBodyBytes"]
}
