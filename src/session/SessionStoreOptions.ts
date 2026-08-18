import type { Clock } from "./Clock.js"
import type { RandomBytes } from "./RandomBytes.js"
import type { TokenReferenceStore } from "./TokenReferenceStore.js"

export type SessionStoreOptions = {
  maxAgeSeconds?: number
  maxEntries?: number
  clock?: Clock
  randomBytes?: RandomBytes
  tokenReferences: TokenReferenceStore
}
