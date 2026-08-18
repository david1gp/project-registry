import type { CaddyApplicationQueue } from "./CaddyApplicationQueue.js"

export function caddyApplicationQueueCreate(): CaddyApplicationQueue {
  let tail = Promise.resolve()

  return {
    enqueue: <T>(work: () => Promise<T>): Promise<T> => {
      const result = tail.then(work, work)
      tail = result.then(
        () => undefined,
        () => undefined,
      )
      return result
    },
  }
}
