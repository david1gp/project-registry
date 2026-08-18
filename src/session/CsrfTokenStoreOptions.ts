import type { Clock } from "./Clock.js"
import type { RandomBytes } from "./RandomBytes.js"

export type CsrfTokenStoreOptions = {
  clock?: Clock
  randomBytes?: RandomBytes
  maxAgeSeconds?: number
  maxEntries?: number
}
