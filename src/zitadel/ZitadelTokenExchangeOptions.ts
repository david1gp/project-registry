import type { Clock } from "../session/Clock.js"
import type { ZitadelDiscoveryDocument } from "./ZitadelDiscoveryDocument.js"
import type { ZitadelHttp } from "./ZitadelHttp.js"
import type { ZitadelHttpOptions } from "./ZitadelHttpOptions.js"
import type { ZitadelOidcConfig } from "./ZitadelOidcConfig.js"

export type ZitadelTokenExchangeOptions = {
  config: ZitadelOidcConfig
  discovery: ZitadelDiscoveryDocument
  http: ZitadelHttp
  code: string
  codeVerifier: string
  clock?: Clock
  timeoutMs?: ZitadelHttpOptions["timeoutMs"]
  signal?: ZitadelHttpOptions["signal"]
  maxBodyBytes?: ZitadelHttpOptions["maxBodyBytes"]
}
