import type { HistoryPushStatus } from "./historyPushStatusSchema.js"

export type HistoryPushWorker = {
  start(logger?: (message: string) => void): void
  stop(): void
  schedule(): void
  status(): HistoryPushStatus
}
