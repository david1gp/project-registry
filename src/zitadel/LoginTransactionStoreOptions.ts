import type { Clock } from "../session/Clock.js"

export type LoginTransactionStoreOptions = {
  clock?: Clock
  maxEntries?: number
}
