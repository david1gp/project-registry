import type { Clock } from "./Clock.js"
import type { RandomBytes } from "./RandomBytes.js"

export type TokenReferenceStoreOptions = {
  maxEntries?: number
  clock?: Clock
  randomBytes?: RandomBytes
}
