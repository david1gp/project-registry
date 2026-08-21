import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createResult, createResultError } from "#result"
import { createSignalObject } from "#ui/utils/createSignalObject.js"
import { projectAccessLogPanelStateCreate } from "./ProjectAccessLogPanelStateCreate.js"
import type { ProjectAccessLogPage } from "./projectAccessLogPageSchema.js"

const record = {
  timestamp: 1_777_000_000,
  method: "GET",
  host: "app.example",
  path: "/",
  status: 200,
  duration: 0.01,
  responseBytes: 42,
  clientNetwork: "192.0.2.0/24",
}

function page(overrides: Partial<ProjectAccessLogPage> = {}): ProjectAccessLogPage {
  return { records: [record], partial: false, malformedLines: 0, ...overrides }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

function harnessCreate(
  client: NonNullable<NonNullable<Parameters<typeof projectAccessLogPanelStateCreate>[2]>["client"]>,
  owner: () => string = () => "leo",
  name: () => string = () => "app",
) {
  let visibilityState: DocumentVisibilityState = "visible"
  let visibilityHandler: (() => void) | undefined
  const intervalHandlers = new Map<number, () => void>()
  const intervalMilliseconds: number[] = []
  const cleared: number[] = []
  let nextTimer = 0
  const visibilityDocument = {
    get visibilityState() {
      return visibilityState
    },
    addEventListener: (_name: string, handler: EventListenerOrEventListenerObject) => {
      visibilityHandler = handler as () => void
    },
    removeEventListener: (_name: string, handler: EventListenerOrEventListenerObject) => {
      if (visibilityHandler === handler) visibilityHandler = undefined
    },
  }
  const state = projectAccessLogPanelStateCreate(owner, name, {
    client,
    document: visibilityDocument as unknown as Document,
    intervalSet: (handler, milliseconds) => {
      nextTimer += 1
      intervalMilliseconds.push(milliseconds)
      intervalHandlers.set(nextTimer, handler)
      return nextTimer
    },
    intervalClear: (timer) => {
      const id = timer as number
      cleared.push(id)
      intervalHandlers.delete(id)
    },
  })
  return {
    state,
    intervalHandlers,
    intervalMilliseconds,
    cleared,
    visibilitySet(value: DocumentVisibilityState) {
      visibilityState = value
      visibilityHandler?.()
    },
  }
}

describe("projectAccessLogPanelStateCreate", () => {
  test("loads, pages, accumulates partial data, and reports an expired older cursor", async () => {
    const calls: Array<{ before?: string }> = []
    let olderAttempt = 0
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const harness = harnessCreate(async (_owner, _name, options) => {
          calls.push({ before: options?.before })
          if (options?.before === "cursor-2") {
            olderAttempt += 1
            if (olderAttempt === 2) {
              return {
                ...createResultError("test", "expired"),
                code: "access-log.cursor-expired",
                statusCode: 410,
              }
            }
            return createResult(
              page({ records: [{ ...record, path: "/older" }], partial: true, malformedLines: 2, next: "cursor-2" }),
            )
          }
          return createResult(page({ next: "cursor-2" }))
        })
        harness.state.mount()
        await settle()
        expect(harness.state.records()).toHaveLength(1)
        expect(harness.intervalHandlers.size).toBe(1)

        harness.state.olderLoad()
        await settle()
        expect(harness.state.records().map((entry) => entry.path)).toEqual(["/", "/older"])
        expect(harness.state.partial()).toBe(true)
        expect(harness.state.malformedLines()).toBe(2)
        expect(harness.state.partialMessage()).toBe("2 fehlerhafte Protokolleinträge wurden übersprungen.")

        harness.state.olderLoad()
        await settle()
        expect(harness.state.expiredCursor()).toBe(true)
        expect(harness.state.records()).toHaveLength(2)
        expect(calls.map((call) => call.before)).toEqual([undefined, "cursor-2", "cursor-2"])
        harness.state.dispose()
        dispose()
        resolve()
      })
    })
  })

  test("merges background pages, keeps the loaded tail, and removes page overlap", async () => {
    const newest = { ...record, path: "/newest" }
    const overlap = { ...record, path: "/overlap" }
    const oldest = { ...record, path: "/oldest" }
    let calls = 0
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const harness = harnessCreate(async (_owner, _name, options) => {
          calls += 1
          if (options?.before === "tail-1") {
            return createResult(page({ records: [overlap, oldest], next: "tail-2" }))
          }
          if (calls === 3) {
            return createResult(page({ records: [{ ...record, path: "/fresh" }, overlap], next: "fresh-tail" }))
          }
          return createResult(page({ records: [newest, overlap], next: "tail-1" }))
        })
        harness.state.mount()
        await settle()
        harness.state.olderLoad()
        await settle()
        expect(harness.state.records().map((entry) => entry.path)).toEqual(["/newest", "/overlap", "/oldest"])
        expect(harness.state.next()).toBe("tail-2")

        const poll = [...harness.intervalHandlers.values()][0]
        poll?.()
        await settle()
        expect(harness.state.records().map((entry) => entry.path)).toEqual(["/fresh", "/overlap", "/newest", "/oldest"])
        expect(harness.state.next()).toBe("tail-2")
        expect(calls).toBe(3)
        harness.state.dispose()
        dispose()
        resolve()
      })
    })
  })

  test("clears paging request state after a rejected client request", async () => {
    let olderCalls = 0
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const harness = harnessCreate(async (_owner, _name, options) => {
          if (options?.before === undefined) return createResult(page({ next: "tail" }))
          olderCalls += 1
          if (olderCalls === 1) throw new Error("request failed")
          return createResult(page({ records: [{ ...record, path: "/older" }], next: undefined }))
        })
        harness.state.mount()
        await settle()
        harness.state.olderLoad()
        await settle()
        expect(harness.state.olderLoading()).toBe(false)
        harness.state.olderLoad()
        await settle()
        expect(harness.state.olderLoading()).toBe(false)
        expect(harness.state.records().map((entry) => entry.path)).toEqual(["/", "/older"])
        expect(olderCalls).toBe(2)
        harness.state.dispose()
        dispose()
        resolve()
      })
    })
  })

  test("exposes one busy state for initial, refresh, and older requests", async () => {
    const pending: Array<(result: ReturnType<typeof createResult<ProjectAccessLogPage>>) => void> = []
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const harness = harnessCreate(async () => new Promise((resolveRequest) => pending.push(resolveRequest)))
        harness.state.mount()
        expect(harness.state.busy()).toBe(true)
        pending.shift()?.(createResult(page({ next: "tail" })))
        await settle()
        expect(harness.state.busy()).toBe(false)

        harness.state.refresh()
        expect(harness.state.busy()).toBe(true)
        pending.shift()?.(createResult(page({ next: "tail" })))
        await settle()
        expect(harness.state.busy()).toBe(false)

        harness.state.olderLoad()
        expect(harness.state.busy()).toBe(true)
        pending.shift()?.(createResult(page({ records: [], next: undefined })))
        await settle()
        expect(harness.state.busy()).toBe(false)
        harness.state.dispose()
        dispose()
        resolve()
      })
    })
  })

  test("polls only while visible and resumed, then cleans up", async () => {
    let calls = 0
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const harness = harnessCreate(async () => {
          calls += 1
          return createResult(page())
        })
        harness.state.mount()
        await settle()
        expect(calls).toBe(1)
        expect(harness.intervalHandlers.size).toBe(1)
        expect(harness.intervalMilliseconds).toEqual([10_000])

        harness.state.pauseToggle()
        expect(harness.state.paused()).toBe(true)
        expect(harness.intervalHandlers.size).toBe(0)
        harness.state.pauseToggle()
        expect(harness.intervalHandlers.size).toBe(1)
        harness.visibilitySet("hidden")
        expect(harness.intervalHandlers.size).toBe(0)
        harness.visibilitySet("visible")
        expect(harness.intervalHandlers.size).toBe(1)

        const poll = [...harness.intervalHandlers.values()][0]
        poll?.()
        await settle()
        expect(calls).toBe(2)
        harness.state.dispose()
        expect(harness.intervalHandlers.size).toBe(0)
        expect(harness.cleared).toHaveLength(3)
        dispose()
        resolve()
      })
    })
  })

  test("exposes empty and unavailable initial states and preserves records after refresh failure", async () => {
    for (const kind of ["empty", "unavailable", "background"] as const) {
      let calls = 0
      await new Promise<void>((resolve) => {
        createRoot(async (dispose) => {
          const harness = harnessCreate(async () => {
            calls += 1
            if (kind === "unavailable" || (kind === "background" && calls > 1)) {
              return { ...createResultError("test", "unavailable"), code: "access-log.unavailable", statusCode: 503 }
            }
            return createResult(page({ records: kind === "empty" ? [] : [record] }))
          })
          harness.state.mount()
          await settle()
          if (kind === "empty") expect(harness.state.empty()).toBe(true)
          if (kind === "unavailable")
            expect(harness.state.initialErrorMessage()).toBe(
              "Zugriffsprotokolle sind nicht aktiviert oder derzeit nicht verfügbar.",
            )
          if (kind === "background") {
            harness.state.refresh()
            await settle()
            expect(harness.state.backgroundError()).toBe(true)
            expect(harness.state.records()).toEqual([record])
          }
          harness.state.dispose()
          dispose()
          resolve()
        })
      })
    }
  })

  test("maps initial failures to concise no-leak messages", async () => {
    const cases = [
      ["project.not-found", 404, "Projekt nicht gefunden oder kein Zugriff."],
      ["access-log.unavailable", 503, "Zugriffsprotokolle sind nicht aktiviert oder derzeit nicht verfügbar."],
      ["access-log.invalid-input", 400, "Die Protokollanfrage ist ungültig."],
      ["response.malformed", 200, "Der Server hat eine ungültige Protokollantwort gesendet."],
      ["request.unavailable", undefined, "Zugriffsprotokolle konnten nicht geladen werden."],
    ] as const

    for (const [code, statusCode, message] of cases) {
      await new Promise<void>((resolve) => {
        createRoot(async (dispose) => {
          const harness = harnessCreate(async () => ({
            ...createResultError("test", "server detail must not be shown"),
            code,
            statusCode,
          }))
          harness.state.mount()
          await settle()
          expect(harness.state.initialErrorMessage()).toBe(message)
          expect(harness.state.empty()).toBe(false)
          harness.state.dispose()
          dispose()
          resolve()
        })
      })
    }
  })

  test("aborts and clears old project state before loading changed accessors", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const project = createSignalObject({ owner: "leo", name: "old-app" })
        const calls: Array<{
          owner: string
          name: string
          signal: AbortSignal | undefined
          resolve: (result: ReturnType<typeof createResult<ProjectAccessLogPage>>) => void
        }> = []
        let call = 0
        const harness = harnessCreate(
          async (owner, name, options) => {
            call += 1
            if (call === 1) return createResult(page({ next: "old-cursor", partial: true, malformedLines: 2 }))
            if (call === 2) {
              return { ...createResultError("test", "expired"), code: "access-log.cursor-expired", statusCode: 410 }
            }
            if (call === 3) return createResultError("test", "refresh failed")
            return new Promise((resolveCall) =>
              calls.push({ owner, name, signal: options?.signal, resolve: resolveCall }),
            )
          },
          () => project.get().owner,
          () => project.get().name,
        )

        harness.state.mount()
        await settle()
        harness.state.olderLoad()
        await settle()
        harness.state.refresh()
        await settle()
        harness.state.refresh()
        await settle()
        expect(harness.state.expiredCursor()).toBe(true)
        expect(harness.state.backgroundError()).toBe(true)
        expect(calls).toHaveLength(1)

        project.set({ owner: "team", name: "new-app" })
        await settle()

        expect(calls[0]).toMatchObject({ owner: "leo", name: "old-app" })
        expect(calls[0]?.signal?.aborted).toBe(true)
        expect(calls[1]).toMatchObject({ owner: "team", name: "new-app" })
        expect(harness.state.records()).toEqual([])
        expect(harness.state.next()).toBeUndefined()
        expect(harness.state.partial()).toBe(false)
        expect(harness.state.malformedLines()).toBe(0)
        expect(harness.state.expiredCursor()).toBe(false)
        expect(harness.state.backgroundError()).toBe(false)
        expect(harness.state.initialErrorMessage()).toBeUndefined()
        expect(harness.state.initialLoading()).toBe(true)
        expect(harness.state.refreshing()).toBe(false)
        expect(harness.state.olderLoading()).toBe(false)

        calls[0]?.resolve(createResult(page({ records: [{ ...record, path: "/stale" }] })))
        await settle()
        expect(harness.state.records()).toEqual([])

        const newRecord = { ...record, host: "new.example", path: "/new" }
        calls[1]?.resolve(createResult(page({ records: [newRecord] })))
        await settle()
        expect(harness.state.records()).toEqual([newRecord])
        expect(harness.state.initialLoading()).toBe(false)

        harness.state.dispose()
        dispose()
        resolve()
      })
    })
  })
})
