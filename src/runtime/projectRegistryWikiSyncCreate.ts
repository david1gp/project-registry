import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { Project } from "../project/Project.js"
import {
  wikiReconcile as wikiReconcileDefault,
  type WikiReconcileInput,
  type WikiReconcileSummary,
} from "../wiki/wikiReconcile.js"

type WikiSyncReconcile = (input: WikiReconcileInput) => Promise<Result<WikiReconcileSummary>>

export function projectRegistryWikiSyncCreate(options: {
  wikiRoot?: string
  repositoryProjectsCurrent: () => PromiseResult<readonly unknown[]>
  reconcile?: WikiSyncReconcile
  logger?: (message: string) => void
}): Result<{
  startup(): PromiseResult<void>
  shutdown(): PromiseResult<void>
  schedule(): void
  projectCreateAfterPersistence(project: Project, createOptions: { noDns: boolean }): void
  projectEditAfterPersistence(previous: Project, project: Project): void
  projectOrganizeAfterPersistence(): void
}> {
  const op = "projectRegistryWikiSyncCreate"
  if (typeof options !== "object" || options === null) return createResultError(op, "Wiki sync options are required")
  if (
    options.wikiRoot !== undefined &&
    (typeof options.wikiRoot !== "string" || options.wikiRoot === "" || options.wikiRoot.includes("\0"))
  ) {
    return createResultError(op, "Wiki root must be a non-empty path")
  }
  if (typeof options.repositoryProjectsCurrent !== "function") {
    return createResultError(op, "Wiki sync project snapshot accessor is required")
  }
  if (options.reconcile !== undefined && typeof options.reconcile !== "function") {
    return createResultError(op, "Wiki sync reconcile hook is invalid")
  }
  if (options.logger !== undefined && typeof options.logger !== "function") {
    return createResultError(op, "Wiki sync logger is invalid")
  }

  const enabled = options.wikiRoot !== undefined
  const wikiRoot = options.wikiRoot ?? ""
  const snapshotCurrent = options.repositoryProjectsCurrent
  const reconcile: WikiSyncReconcile = options.reconcile ?? wikiReconcileDefault
  const writeLog = options.logger ?? ((message: string) => console.info(message))
  let started = false
  let stopped = false
  let dirty = false
  let drainPromise: Promise<void> | undefined
  let startupPromise: PromiseResult<void> | undefined
  let shutdownPromise: PromiseResult<void> | undefined

  function log(message: string): void {
    try {
      writeLog(message)
    } catch {
      // Logging must not affect project mutations or queue shutdown.
    }
  }

  function reconcileLogger(): { info(message: string): void; warn(message: string): void } {
    return {
      info: (message) => log(message),
      warn: (message) => log(message),
    }
  }

  async function reconcileOnce(): Promise<void> {
    let snapshot: Awaited<ReturnType<typeof snapshotCurrent>>
    try {
      snapshot = await snapshotCurrent()
    } catch {
      log("wiki sync snapshot outcome=failure reason=unexpected-error")
      return
    }
    if (!snapshot.success) {
      log(`wiki sync snapshot outcome=failure reason=${snapshot.errorMessage}`)
      return
    }
    if (stopped) return
    try {
      // The writer filters to owner Leo and skips ambiguous matches; the
      // latest persisted snapshot is always read here so concurrent
      // mutations cannot reconcile stale project metadata.
      const result = await reconcile({
        root: wikiRoot,
        owner: "leo",
        snapshot: { projects: snapshot.data },
        logger: reconcileLogger(),
      })
      if (!result.success) log(`wiki sync outcome=failure reason=${result.errorMessage}`)
      else if (result.data.created > 0 || result.data.updated > 0) {
        log(`wiki sync outcome=success created=${result.data.created} updated=${result.data.updated}`)
      }
    } catch {
      log("wiki sync outcome=failure reason=unexpected-error")
    }
  }

  function drainSchedule(): void {
    if (drainPromise !== undefined) return
    const current = Promise.resolve()
      .then(async () => {
        while (dirty && !stopped) {
          dirty = false
          await reconcileOnce()
        }
      })
      .catch(() => undefined)
    drainPromise = current
    void current.then(() => {
      if (drainPromise === current) {
        drainPromise = undefined
        if (dirty && !stopped) drainSchedule()
      }
    })
  }

  function schedule(): void {
    if (!enabled || !started || stopped) return
    dirty = true
    drainSchedule()
  }

  function startup(): PromiseResult<void> {
    if (!enabled) return Promise.resolve(createResult(undefined))
    if (startupPromise !== undefined) return startupPromise
    started = true
    dirty = true
    drainSchedule()
    const initial = drainPromise ?? Promise.resolve()
    // Sync errors are logged inside the drain and never fail daemon startup;
    // awaiting the initial pass keeps startup ordered with later mutations.
    const current = initial.then(
      () => createResult(undefined),
      () => createResult(undefined),
    )
    startupPromise = current
    return current
  }

  function shutdown(): PromiseResult<void> {
    if (shutdownPromise !== undefined) return shutdownPromise
    stopped = true
    const pending: Promise<unknown>[] = []
    if (startupPromise !== undefined) pending.push(startupPromise)
    if (drainPromise !== undefined) pending.push(drainPromise)
    const current =
      pending.length === 0
        ? Promise.resolve(createResult(undefined))
        : Promise.all(pending).then(
            () => createResult(undefined),
            () => createResultError(op, "Wiki sync shutdown failed"),
          )
    shutdownPromise = current
    return current
  }

  return createResult({
    startup,
    shutdown,
    schedule,
    projectCreateAfterPersistence: () => schedule(),
    projectEditAfterPersistence: () => schedule(),
    projectOrganizeAfterPersistence: () => schedule(),
  })
}
