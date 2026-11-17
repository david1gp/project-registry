import { describe, expect, test } from "bun:test"
import { createResult, createResultError } from "#result"
import { historyPushWorkerCreate } from "./historyPushWorkerCreate.js"

function timerCreate() {
  let next = 0
  const callbacks = new Map<number, { callback: () => void; delayMs: number }>()
  return {
    setTimeout(callback: () => void, delayMs: number) {
      callbacks.set(++next, { callback, delayMs })
      return next
    },
    clearTimeout(handle: unknown) {
      callbacks.delete(handle as number)
    },
    delays: () => [...callbacks.values()].map(({ delayMs }) => delayMs),
    async fire() {
      expect(callbacks.size).toBe(1)
      const [key, entry] = [...callbacks.entries()][0]!
      callbacks.delete(key)
      // The worker callback returns its task, allowing deterministic draining
      // without a real clock, sleeps, polling, or global mock timers.
      await entry.callback()
    },
  }
}

describe("historyPushWorkerCreate", () => {
  test("coalesces all commits during an in-flight push into one latest-HEAD push", async () => {
    const timer = timerCreate()
    const blocked = Promise.withResolvers<void>()
    const entered = Promise.withResolvers<void>()
    let revision = "initial"
    const pushed: string[] = []
    const worker = historyPushWorkerCreate({
      enabled: true,
      timer,
      snapshot: async () => createResult({ revision, aheadCount: 1 }),
      push: async (sha) => {
        pushed.push(sha)
        if (pushed.length === 1) {
          entered.resolve()
          await blocked.promise
        }
        return createResult(undefined)
      },
    })
    worker.start()
    const first = timer.fire()
    await entered.promise
    for (let commit = 1; commit <= 10; commit += 1) {
      revision = `commit-${commit}`
      worker.schedule()
    }
    expect(worker.status()).toMatchObject({ pending: true, inFlight: true })
    expect(pushed).toEqual(["initial"])
    expect(timer.delays()).toEqual([])
    blocked.resolve()
    await first
    expect(timer.delays()).toEqual([0])
    await timer.fire()
    expect(pushed).toEqual(["initial", "commit-10"])
    expect(worker.status()).toMatchObject({ pending: false, inFlight: false, lastPushedRevision: "commit-10" })
    expect(timer.delays()).toEqual([])
    worker.stop()
  })

  test("retains and logs failures, retries with capped backoff, and a mutation retries immediately", async () => {
    const timer = timerCreate()
    let now = 1000
    let failing = true
    const logs: string[] = []
    const worker = historyPushWorkerCreate({
      enabled: true,
      timer,
      clock: () => now,
      snapshot: async () => createResult({ revision: "latest", aheadCount: 2 }),
      push: async () =>
        failing ? createResultError("push", "denied https://user:secret@git.example/repo") : createResult(undefined),
    })
    worker.start((message) => logs.push(message))
    for (const [index, delay] of [30_000, 120_000, 600_000, 600_000].entries()) {
      now += 100
      await timer.fire()
      expect(worker.status()).toMatchObject({
        pending: true,
        inFlight: false,
        consecutiveFailures: index + 1,
        lastAttemptAt: now,
        lastError: { message: "denied https://[redacted]@git.example/repo", at: now },
      })
      expect(timer.delays()).toEqual([delay])
    }
    expect(logs).toHaveLength(4)
    expect(logs.join("\n")).not.toContain("secret")
    worker.schedule()
    expect(timer.delays()).toEqual([0])
    failing = false
    await timer.fire()
    expect(worker.status()).toMatchObject({
      pending: false,
      lastError: null,
      consecutiveFailures: 0,
      lastSuccessAt: now,
      lastPushedRevision: "latest",
      aheadCount: 0,
    })
    expect(timer.delays()).toEqual([])
    worker.stop()
  })

  test("checks local ahead state at startup and pushes only when catch-up is needed", async () => {
    for (const aheadCount of [0, 3]) {
      const timer = timerCreate()
      const pushed: string[] = []
      const worker = historyPushWorkerCreate({
        enabled: true,
        timer,
        snapshot: async () => createResult({ revision: "persisted-before-restart", aheadCount }),
        push: async (revision) => {
          pushed.push(revision)
          return createResult(undefined)
        },
      })
      worker.start()
      await timer.fire()
      expect(pushed).toEqual(aheadCount === 0 ? [] : ["persisted-before-restart"])
      expect(worker.status().pending).toBe(false)
      worker.stop()
    }
  })

  test("shutdown cancels retries and never starts a coalesced follow-up after an active push", async () => {
    const timer = timerCreate()
    const entered = Promise.withResolvers<void>()
    const blocked = Promise.withResolvers<void>()
    const worker = historyPushWorkerCreate({
      enabled: true,
      timer,
      snapshot: async () => createResult({ revision: "head", aheadCount: 1 }),
      push: async () => {
        entered.resolve()
        await blocked.promise
        return createResultError("push", "offline")
      },
    })
    worker.start(() => undefined)
    const attempt = timer.fire()
    await entered.promise
    worker.schedule()
    worker.stop()
    blocked.resolve()
    await attempt
    expect(timer.delays()).toEqual([])
    expect(worker.status()).toMatchObject({ pending: true, inFlight: false, lastError: { message: "offline" } })
  })
})
