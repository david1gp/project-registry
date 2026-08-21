import { types } from "node:util"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectAccessLogId } from "../access-log/projectAccessLogId.js"
import { projectAccessLogRetentionMaximumActiveProjectIds } from "../access-log/projectAccessLogRetentionMaximumActiveProjectIds.js"
import { projectAccessLogRetentionReconcile } from "../access-log/projectAccessLogRetentionReconcile.js"
import { projectSchema } from "../project/projectSchema.js"
import type { ProjectRepositorySnapshot } from "../project-store/ProjectRepositorySnapshot.js"
import type { CaddyApplication } from "./CaddyApplication.js"
import type { CaddyApplicationOptions } from "./CaddyApplicationOptions.js"
import type { CaddyApplicationResult } from "./CaddyApplicationResult.js"
import type { CaddyApplicationStatus } from "./CaddyApplicationStatus.js"
import type { CaddyTimer } from "./CaddyTimer.js"
import { caddyAdminLoad } from "./caddyAdminLoad.js"
import { caddyApplicationQueueCreate } from "./caddyApplicationQueueCreate.js"
import { caddyConfigGenerate } from "./caddyConfigGenerate.js"
import { caddyConfigSerialize } from "./caddyConfigSerialize.js"
import { caddyConfigValidate } from "./caddyConfigValidate.js"

const defaultIntervalMs = 60_000
const defaultMaxRetries = 2
const defaultRetryDelayMs = 1_000

type QueuedSnapshot = {
  snapshot: ProjectRepositorySnapshot
  force: boolean
  initialize: boolean
  sequence: number
}

type TriggerOperation = {
  sequence: number
  force: boolean
  initialize: boolean
  promise: PromiseResult<CaddyApplicationResult>
  resolve: (result: Result<CaddyApplicationResult>) => void
  settled: boolean
}

type SuccessfulCaddyLoadHandler = (snapshot: ProjectRepositorySnapshot, now: number, sequence: number) => void

function caddyTimerDefault(): CaddyTimer {
  return {
    wait: (delayMs, signal) =>
      new Promise((resolve, reject) => {
        if (signal?.aborted) {
          reject(new Error("Caddy wait cancelled"))
          return
        }
        const onAbort = () => {
          globalThis.clearTimeout(handle)
          signal?.removeEventListener("abort", onAbort)
          reject(new Error("Caddy wait cancelled"))
        }
        const handle = globalThis.setTimeout(() => {
          signal?.removeEventListener("abort", onAbort)
          resolve()
        }, delayMs)
        signal?.addEventListener("abort", onAbort, { once: true })
      }),
    setInterval: (callback, delayMs) => globalThis.setInterval(callback, delayMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as number),
    setTimeout: (callback, delayMs) => globalThis.setTimeout(callback, delayMs),
    clearTimeout: (handle) => globalThis.clearTimeout(handle as number),
  }
}

function caddyApplicationStatusCopy(status: CaddyApplicationStatus): CaddyApplicationStatus {
  return { ...status }
}

type CaddyApplicationOptionValues = Record<string, unknown>

type CaddyApplicationProperty = {
  found: boolean
  value: unknown
}

type CaddyApplicationCallable = (...args: never[]) => unknown

function caddyApplicationOptionsValues(options: unknown): CaddyApplicationOptionValues {
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    types.isProxy(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new Error("invalid options")
  }

  const values: CaddyApplicationOptionValues = Object.create(null) as CaddyApplicationOptionValues
  const names = [
    "repository",
    "configOptions",
    "caddyBin",
    "adminUrl",
    "processRunner",
    "fetch",
    "clock",
    "timer",
    "intervalMs",
    "maxRetries",
    "retryDelayMs",
    "validationTimeoutMs",
    "loadTimeoutMs",
    "initializeFromGeneratedConfig",
  ]
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !names.includes(key)) throw new Error("invalid options")
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid options")
    }
    values[key] = descriptor.value
  }
  return values
}

function caddyApplicationPropertyValue(input: object, key: string): CaddyApplicationProperty {
  let current: object | null = input
  while (current !== null) {
    if (types.isProxy(current)) throw new Error("proxy option")
    const descriptor = Object.getOwnPropertyDescriptor(current, key)
    if (descriptor !== undefined) {
      if (!("value" in descriptor)) throw new Error("accessor option")
      return { found: true, value: descriptor.value }
    }
    current = Object.getPrototypeOf(current)
  }
  return { found: false, value: undefined }
}

function caddyApplicationCallable(value: unknown): value is CaddyApplicationCallable {
  return typeof value === "function" && !types.isProxy(value)
}

function caddyApplicationRepositoryNormalize(value: unknown): Pick<CaddyApplicationOptions["repository"], "read"> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    throw new Error("invalid repository")
  }
  const read = caddyApplicationPropertyValue(value, "read")
  const readFunction = read.value
  if (!read.found || !caddyApplicationCallable(readFunction)) throw new Error("invalid repository")
  return {
    read: () => Reflect.apply(readFunction, value, []) as ReturnType<CaddyApplicationOptions["repository"]["read"]>,
  }
}

function caddyApplicationRepositoryOwnValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error("invalid result")
  return descriptor.value
}

function caddyApplicationRepositoryHasKeys(input: object, keys: readonly string[]): boolean {
  const ownKeys = Reflect.ownKeys(input)
  return ownKeys.length === keys.length && ownKeys.every((key) => typeof key === "string" && keys.includes(key))
}

function caddyApplicationRepositorySnapshotNormalize(value: unknown): ProjectRepositorySnapshot | undefined {
  try {
    if (
      typeof value !== "object" ||
      value === null ||
      Array.isArray(value) ||
      types.isProxy(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      !caddyApplicationRepositoryHasKeys(value, ["success", "data"])
    ) {
      return undefined
    }
    const success = caddyApplicationRepositoryOwnValue(value, "success")
    if (success !== true) return undefined
    const data = caddyApplicationRepositoryOwnValue(value, "data")
    if (
      typeof data !== "object" ||
      data === null ||
      Array.isArray(data) ||
      types.isProxy(data) ||
      Object.getPrototypeOf(data) !== Object.prototype ||
      !caddyApplicationRepositoryHasKeys(data, ["revision", "projects"])
    ) {
      return undefined
    }
    const revision = caddyApplicationRepositoryOwnValue(data, "revision")
    const projects = caddyApplicationRepositoryOwnValue(data, "projects")
    if (typeof revision !== "string" || !Array.isArray(projects) || types.isProxy(projects)) return undefined

    const serializedR = caddyConfigSerialize(data)
    if (!serializedR.success) return undefined
    const projectsR = a.safeParse(a.array(projectSchema), projects)
    if (!projectsR.success) return undefined
    return { revision, projects: projectsR.output }
  } catch {
    return undefined
  }
}

function caddyApplicationTimerNormalize(value: unknown): CaddyTimer | undefined {
  if (value === undefined) return undefined
  if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) {
    throw new Error("invalid timer")
  }

  const wait = caddyApplicationPropertyValue(value, "wait")
  const setInterval = caddyApplicationPropertyValue(value, "setInterval")
  const clearInterval = caddyApplicationPropertyValue(value, "clearInterval")
  const setTimeout = caddyApplicationPropertyValue(value, "setTimeout")
  const clearTimeout = caddyApplicationPropertyValue(value, "clearTimeout")
  const waitFunction = wait.value
  const setIntervalFunction = setInterval.value
  const clearIntervalFunction = clearInterval.value
  const setTimeoutFunction = setTimeout.value
  const clearTimeoutFunction = clearTimeout.value
  if (
    !wait.found ||
    !caddyApplicationCallable(waitFunction) ||
    !setInterval.found ||
    !caddyApplicationCallable(setIntervalFunction) ||
    !clearInterval.found ||
    !caddyApplicationCallable(clearIntervalFunction)
  ) {
    throw new Error("invalid timer")
  }
  if (
    (setTimeout.found && !caddyApplicationCallable(setTimeoutFunction)) ||
    (clearTimeout.found && !caddyApplicationCallable(clearTimeoutFunction))
  ) {
    throw new Error("invalid timer")
  }

  const normalized: CaddyTimer = {
    wait: (delayMs, signal) => Reflect.apply(waitFunction, value, [delayMs, signal]) as Promise<void>,
    setInterval: (callback, delayMs) => Reflect.apply(setIntervalFunction, value, [callback, delayMs]),
    clearInterval: (handle) => {
      Reflect.apply(clearIntervalFunction, value, [handle])
    },
  }
  if (setTimeout.found) {
    if (!caddyApplicationCallable(setTimeoutFunction)) throw new Error("invalid timer")
    normalized.setTimeout = (callback, delayMs) => Reflect.apply(setTimeoutFunction, value, [callback, delayMs])
  }
  if (clearTimeout.found) {
    if (!caddyApplicationCallable(clearTimeoutFunction)) throw new Error("invalid timer")
    normalized.clearTimeout = (handle) => {
      Reflect.apply(clearTimeoutFunction, value, [handle])
    }
  }
  return normalized
}

function caddyApplicationOptionsValidate(options: unknown): Result<CaddyApplicationOptions> {
  const op = "caddyApplicationCreate"
  let values: CaddyApplicationOptionValues
  try {
    values = caddyApplicationOptionsValues(options)
  } catch {
    return createResultError(op, "Caddy application options are invalid")
  }

  let repository: CaddyApplicationOptions["repository"]
  let timer: CaddyTimer | undefined
  try {
    repository = caddyApplicationRepositoryNormalize(values.repository)
    timer = caddyApplicationTimerNormalize(values.timer)
  } catch {
    return createResultError(op, "Caddy application options are invalid")
  }

  const intervalMs = values.intervalMs === undefined ? defaultIntervalMs : values.intervalMs
  if (typeof intervalMs !== "number" || !Number.isInteger(intervalMs) || intervalMs < 1) {
    return createResultError(op, "intervalMs must be a positive integer")
  }
  const maxRetries = values.maxRetries === undefined ? defaultMaxRetries : values.maxRetries
  if (typeof maxRetries !== "number" || !Number.isInteger(maxRetries) || maxRetries < 0) {
    return createResultError(op, "maxRetries must be a non-negative integer")
  }
  const retryDelayMs = values.retryDelayMs === undefined ? defaultRetryDelayMs : values.retryDelayMs
  if (typeof retryDelayMs !== "number" || !Number.isInteger(retryDelayMs) || retryDelayMs < 0) {
    return createResultError(op, "retryDelayMs must be a non-negative integer")
  }
  if (
    values.validationTimeoutMs !== undefined &&
    (typeof values.validationTimeoutMs !== "number" ||
      !Number.isInteger(values.validationTimeoutMs) ||
      values.validationTimeoutMs < 1)
  ) {
    return createResultError(op, "validationTimeoutMs must be a positive integer")
  }
  if (
    values.loadTimeoutMs !== undefined &&
    (typeof values.loadTimeoutMs !== "number" || !Number.isInteger(values.loadTimeoutMs) || values.loadTimeoutMs < 1)
  ) {
    return createResultError(op, "loadTimeoutMs must be a positive integer")
  }
  if (values.initializeFromGeneratedConfig !== undefined && typeof values.initializeFromGeneratedConfig !== "boolean") {
    return createResultError(op, "initializeFromGeneratedConfig must be a boolean")
  }

  if (values.caddyBin !== undefined && typeof values.caddyBin !== "string") {
    return createResultError(op, "caddyBin must be a string")
  }
  if (values.adminUrl !== undefined && typeof values.adminUrl !== "string") {
    return createResultError(op, "adminUrl must be a string")
  }
  if (values.processRunner !== undefined && !caddyApplicationCallable(values.processRunner)) {
    return createResultError(op, "processRunner must be a function")
  }
  if (values.fetch !== undefined && !caddyApplicationCallable(values.fetch)) {
    return createResultError(op, "fetch must be a function")
  }
  if (values.clock !== undefined && !caddyApplicationCallable(values.clock)) {
    return createResultError(op, "clock must be a function")
  }

  return createResult({
    repository,
    configOptions: values.configOptions as CaddyApplicationOptions["configOptions"],
    caddyBin: values.caddyBin as CaddyApplicationOptions["caddyBin"],
    adminUrl: values.adminUrl as CaddyApplicationOptions["adminUrl"],
    processRunner: values.processRunner as CaddyApplicationOptions["processRunner"],
    fetch: values.fetch as CaddyApplicationOptions["fetch"],
    clock: values.clock as CaddyApplicationOptions["clock"],
    timer,
    intervalMs,
    maxRetries,
    retryDelayMs,
    validationTimeoutMs: values.validationTimeoutMs as CaddyApplicationOptions["validationTimeoutMs"],
    loadTimeoutMs: values.loadTimeoutMs as CaddyApplicationOptions["loadTimeoutMs"],
    initializeFromGeneratedConfig:
      values.initializeFromGeneratedConfig as CaddyApplicationOptions["initializeFromGeneratedConfig"],
  })
}

export function caddyApplicationCreate(options: CaddyApplicationOptions): Result<CaddyApplication>
export function caddyApplicationCreate(options: unknown): Result<CaddyApplication>
export function caddyApplicationCreate(options: unknown): Result<CaddyApplication> {
  const optionsR = caddyApplicationOptionsValidate(options)
  if (!optionsR.success) return optionsR
  const applicationOptions = optionsR.data

  const clock = applicationOptions.clock ?? Date.now
  const timer = applicationOptions.timer ?? caddyTimerDefault()
  const queue = caddyApplicationQueueCreate()
  const maxRetries = applicationOptions.maxRetries ?? defaultMaxRetries
  const retryDelayMs = applicationOptions.retryDelayMs ?? defaultRetryDelayMs
  const intervalMs = applicationOptions.intervalMs ?? defaultIntervalMs
  const initializeFromGeneratedConfig = applicationOptions.initializeFromGeneratedConfig ?? false
  let status: CaddyApplicationStatus = { pending: false }
  let lastAppliedSerialized: string | undefined
  let reloadRequired = false
  let pending: QueuedSnapshot | undefined
  let running: PromiseResult<CaddyApplicationResult> | undefined
  let intervalHandle: unknown
  let intervalStarted = false
  let stopped = false
  let stopPromise: Promise<void> | undefined
  const stopController = new AbortController()
  let retentionReconciliationDirty = false
  let triggerSequence = 0
  let latestTrigger: TriggerOperation | undefined
  let statusSequence = 0
  const triggerOperations = new Set<TriggerOperation>()

  function stoppedResult(): Result<CaddyApplicationResult> {
    return createResultError("caddyApplication", "Caddy application stopped")
  }

  async function awaitWithStop<T>(operation: Promise<T>): Promise<{ cancelled: true } | { cancelled: false; data: T }> {
    if (stopController.signal.aborted) return { cancelled: true }
    let cancellationCleanup: () => void = () => undefined
    const cancellation = new Promise<{ cancelled: true }>((resolve) => {
      const onAbort = () => resolve({ cancelled: true })
      stopController.signal.addEventListener("abort", onAbort, { once: true })
      cancellationCleanup = () => stopController.signal.removeEventListener("abort", onAbort)
    })
    const operationPromise = Promise.resolve(operation)
    try {
      return await Promise.race([operationPromise.then((data) => ({ cancelled: false as const, data })), cancellation])
    } finally {
      cancellationCleanup()
    }
  }

  async function retryWait(): Promise<Result<true>> {
    if (stopController.signal.aborted) return createResultError("caddyApplication", "Caddy application stopped")
    const waitPromise = Promise.resolve().then(() => timer.wait(retryDelayMs, stopController.signal))
    try {
      const waitR = await awaitWithStop(waitPromise)
      if (waitR.cancelled) return createResultError("caddyApplication", "Caddy application stopped")
      return createResult(true)
    } catch {
      return createResultError("caddyApplication", "Caddy retry scheduling failed")
    }
  }

  function statusError(
    message: string,
    snapshot: ProjectRepositorySnapshot,
    sequence: number,
  ): Result<CaddyApplicationResult> {
    reloadRequired = true
    if (statusSequence === sequence) {
      status = {
        ...status,
        pending: true,
        pendingRevision: status.desiredRevision ?? snapshot.revision,
        error: message,
      }
    } else {
      status = {
        ...status,
        pending: true,
        pendingRevision: status.pendingRevision ?? status.desiredRevision,
      }
    }
    return createResultError("caddyApplication", message)
  }

  function statusDesired(snapshot: ProjectRepositorySnapshot, sequence: number): void {
    statusSequence = sequence
    status = {
      ...status,
      desiredRevision: snapshot.revision,
      pendingRevision: snapshot.revision,
      pending: true,
      error: undefined,
    }
  }

  function statusReadFailure(sequence: number): Result<CaddyApplicationResult> {
    statusSequence = sequence
    const desiredApplied =
      !reloadRequired && status.desiredRevision !== undefined && status.desiredRevision === status.appliedRevision
    const pendingNow = !desiredApplied && (status.pending || reloadRequired)
    status = {
      ...status,
      pending: pendingNow,
      pendingRevision: pendingNow ? (status.pendingRevision ?? status.desiredRevision) : undefined,
      error: "project registry read failed",
    }
    return createResultError("caddyApplication", "project registry read failed")
  }

  function triggerResultLatest(
    operation: TriggerOperation,
    result: Result<CaddyApplicationResult>,
  ): PromiseResult<CaddyApplicationResult> {
    if (latestTrigger === undefined || latestTrigger === operation) return Promise.resolve(result)
    return latestTrigger.promise
  }

  async function snapshotApply(
    snapshot: ProjectRepositorySnapshot,
    force: boolean,
    initialize: boolean,
    sequence: number,
    successfulCaddyLoad: SuccessfulCaddyLoadHandler,
  ): PromiseResult<CaddyApplicationResult> {
    if (stopped) return stoppedResult()
    status = {
      ...status,
      pending: true,
      pendingRevision: status.desiredRevision ?? snapshot.revision,
      lastAttempt: clock(),
      error: statusSequence === sequence ? undefined : status.error,
    }
    const generatedR = caddyConfigGenerate(snapshot.projects, applicationOptions.configOptions)
    if (stopped) return stoppedResult()
    if (!generatedR.success) {
      return statusError(generatedR.errorMessage, snapshot, sequence)
    }

    const serializedR = caddyConfigSerialize(generatedR.data)
    if (stopped) return stoppedResult()
    if (!serializedR.success) {
      return statusError(serializedR.errorMessage, snapshot, sequence)
    }

    if (!initialize && !force && !reloadRequired && lastAppliedSerialized === serializedR.data) {
      if (statusSequence === sequence) {
        status = {
          ...status,
          desiredRevision: snapshot.revision,
          appliedRevision: snapshot.revision,
          pendingRevision: undefined,
          pending: false,
          error: undefined,
        }
      }
      if (retentionReconciliationDirty) successfulCaddyLoad(snapshot, clock(), sequence)
      return createResult({ revision: snapshot.revision, changed: false, applied: true, attempts: 0 })
    }

    let lastError = "Caddy application failed"
    for (let retry = 0; retry <= maxRetries; retry += 1) {
      if (stopped) return stoppedResult()
      status = {
        ...status,
        pending: true,
        pendingRevision: status.pendingRevision ?? status.desiredRevision ?? snapshot.revision,
        lastAttempt: clock(),
        error: statusSequence === sequence ? undefined : status.error,
      }

      const validateR = await caddyConfigValidate(generatedR.data, {
        caddyBin: applicationOptions.caddyBin,
        processRunner: applicationOptions.processRunner,
        timeoutMs: applicationOptions.validationTimeoutMs,
        signal: stopController.signal,
        timer,
      })
      if (stopped) return stoppedResult()
      if (!validateR.success) {
        lastError = validateR.errorMessage
      } else if (initialize) {
        const now = clock()
        status = {
          ...status,
          desiredRevision: snapshot.revision,
          appliedRevision: snapshot.revision,
          pendingRevision: undefined,
          pending: false,
          lastSuccess: now,
          error: undefined,
        }
        lastAppliedSerialized = serializedR.data
        reloadRequired = false
        successfulCaddyLoad(snapshot, now, sequence)
        return createResult({ revision: snapshot.revision, changed: false, applied: true, attempts: retry + 1 })
      } else {
        const loadR = await caddyAdminLoad(generatedR.data, {
          adminUrl: applicationOptions.adminUrl,
          fetch: applicationOptions.fetch,
          timeoutMs: applicationOptions.loadTimeoutMs,
          signal: stopController.signal,
          timer,
        })
        if (stopped) return stoppedResult()
        if (loadR.success) {
          const now = clock()
          if (statusSequence === sequence) {
            status = {
              ...status,
              desiredRevision: snapshot.revision,
              appliedRevision: snapshot.revision,
              pendingRevision: undefined,
              pending: false,
              lastSuccess: now,
              error: undefined,
            }
          } else {
            const newerRevisionPending =
              status.desiredRevision !== undefined && status.desiredRevision !== snapshot.revision
            status = {
              ...status,
              appliedRevision: snapshot.revision,
              pending: newerRevisionPending,
              pendingRevision: newerRevisionPending ? (status.pendingRevision ?? status.desiredRevision) : undefined,
              lastSuccess: now,
            }
          }
          lastAppliedSerialized = serializedR.data
          reloadRequired = false
          successfulCaddyLoad(snapshot, now, sequence)
          return createResult({ revision: snapshot.revision, changed: true, applied: true, attempts: retry + 1 })
        }
        lastError = loadR.errorMessage
      }

      if (statusSequence === sequence) status = { ...status, error: lastError }
      if (pending !== undefined) break
      if (retry < maxRetries) {
        const waitR = await retryWait()
        if (!waitR.success) return stopped ? stoppedResult() : statusError(waitR.errorMessage, snapshot, sequence)
        if (pending !== undefined) break
      }
    }

    if (initialize) {
      reloadRequired = true
      if (statusSequence === sequence) {
        status = {
          ...status,
          pending: true,
          pendingRevision: status.desiredRevision ?? snapshot.revision,
          error: lastError,
        }
      }
      return createResult({ revision: snapshot.revision, changed: false, applied: false, attempts: maxRetries + 1 })
    }

    reloadRequired = true
    if (statusSequence === sequence) {
      status = {
        ...status,
        pending: true,
        pendingRevision: status.desiredRevision ?? snapshot.revision,
        error: lastError,
      }
    }
    return createResultError("caddyApplication", lastError)
  }

  async function queueDrain(): PromiseResult<CaddyApplicationResult> {
    let result: Result<CaddyApplicationResult> = createResultError("caddyApplication", "no Caddy application queued")
    while (!stopped) {
      let latestSuccessfulCaddyLoad: { snapshot: ProjectRepositorySnapshot; now: number; sequence: number } | undefined
      while (pending !== undefined && !stopped) {
        const queued = pending
        pending = undefined
        try {
          result = await snapshotApply(
            queued.snapshot,
            queued.force,
            queued.initialize,
            queued.sequence,
            (snapshot, now, sequence) => {
              latestSuccessfulCaddyLoad = { snapshot, now, sequence }
            },
          )
        } catch {
          result = stopped ? stoppedResult() : statusError("Caddy application failed", queued.snapshot, queued.sequence)
        }
      }

      if (stopped) {
        pending = undefined
        return stoppedResult()
      }
      const accessLogRoot = applicationOptions.configOptions?.caddyAccessLogRoot
      const successfulRevision = latestSuccessfulCaddyLoad?.snapshot.revision
      const successfulSequence = latestSuccessfulCaddyLoad?.sequence
      if (result.success && latestSuccessfulCaddyLoad !== undefined && accessLogRoot !== undefined) {
        const stillCurrent = () =>
          !stopped &&
          latestTrigger?.sequence === successfulSequence &&
          !status.pending &&
          status.pendingRevision === undefined &&
          status.desiredRevision === successfulRevision &&
          status.appliedRevision === successfulRevision
        if (stillCurrent()) {
          try {
            const activeProjectIds = latestSuccessfulCaddyLoad.snapshot.projects
              .filter((project) => project.caddy !== undefined && project.caddy !== null && !project.caddy.disabled)
              .map(projectAccessLogId)
            // An over-limit snapshot is not reconciled. Never truncate it: a partial active set could delete live logs.
            if (activeProjectIds.length <= projectAccessLogRetentionMaximumActiveProjectIds) {
              const reconciliationR = await projectAccessLogRetentionReconcile({
                root: accessLogRoot,
                activeProjectIds,
                now: latestSuccessfulCaddyLoad.now,
                stillCurrent,
              })
              if (reconciliationR.success) {
                if (stillCurrent()) retentionReconciliationDirty = false
              } else if (stillCurrent()) {
                retentionReconciliationDirty = true
              }
            }
          } catch {
            if (stillCurrent()) retentionReconciliationDirty = true
            // Caddy has already accepted the configuration; retention is best effort and must not change that result.
          }
        }
      }
      if (pending === undefined) return result
    }
    pending = undefined
    return stoppedResult()
  }

  function snapshotQueue(
    snapshot: ProjectRepositorySnapshot,
    force: boolean,
    initialize: boolean,
    sequence: number,
  ): PromiseResult<CaddyApplicationResult> {
    if (stopped) return Promise.resolve(stoppedResult())
    pending = {
      snapshot,
      force: force || pending?.force === true,
      initialize,
      sequence,
    }
    if (running !== undefined) return running

    running = queue.enqueue(queueDrain)
    const current = running
    void current.then(
      () => {
        if (running === current) running = undefined
      },
      () => {
        if (running === current) running = undefined
      },
    )
    return current
  }

  async function triggerRead(operation: TriggerOperation): PromiseResult<CaddyApplicationResult> {
    if (stopped) return stoppedResult()
    let snapshotRWait: { cancelled: true } | { cancelled: false; data: unknown }
    try {
      snapshotRWait = await awaitWithStop(Promise.resolve().then(() => applicationOptions.repository.read()))
    } catch {
      if (stopped) return stoppedResult()
      if (latestTrigger !== operation)
        return latestTrigger?.promise ?? createResultError("caddyApplication", "project registry read failed")
      return statusReadFailure(operation.sequence)
    }
    if (snapshotRWait.cancelled || stopped) return stoppedResult()
    const snapshot = caddyApplicationRepositorySnapshotNormalize(snapshotRWait.data)
    if (snapshot === undefined) {
      if (latestTrigger !== operation)
        return latestTrigger?.promise ?? createResultError("caddyApplication", "project registry read failed")
      return triggerResultLatest(operation, statusReadFailure(operation.sequence))
    }
    if (latestTrigger !== operation)
      return latestTrigger?.promise ?? createResultError("caddyApplication", "project registry read failed")

    statusDesired(snapshot, operation.sequence)
    const queued = snapshotQueue(snapshot, operation.force, operation.initialize, operation.sequence)
    const result = await queued
    return triggerResultLatest(operation, result)
  }

  function trigger(force: boolean, initialize = false): PromiseResult<CaddyApplicationResult> {
    if (stopped) return Promise.resolve(stoppedResult())
    const sequence = triggerSequence + 1
    triggerSequence = sequence
    let resolveTrigger!: (result: Result<CaddyApplicationResult>) => void
    const promise: PromiseResult<CaddyApplicationResult> = new Promise((resolve) => {
      resolveTrigger = resolve
    })
    const operation: TriggerOperation = {
      sequence,
      force,
      initialize,
      promise,
      resolve: resolveTrigger,
      settled: false,
    }
    latestTrigger = operation
    triggerOperations.add(operation)
    void triggerRead(operation).then(
      (result) => {
        if (operation.settled) return
        operation.settled = true
        operation.resolve(result)
        triggerOperations.delete(operation)
      },
      () => {
        if (operation.settled) return
        operation.settled = true
        operation.resolve(createResultError("caddyApplication", "Caddy application failed"))
        triggerOperations.delete(operation)
      },
    )
    return promise
  }

  function startInterval(): void {
    if (intervalStarted || stopped) return
    intervalStarted = true
    try {
      intervalHandle = timer.setInterval(() => {
        if (!stopped) void trigger(false)
      }, intervalMs)
    } catch (error) {
      intervalStarted = false
      throw error
    }
  }

  function intervalSchedulingFailure(): Result<CaddyApplicationResult> {
    const error = "Caddy interval scheduling failed"
    const pendingNow = status.pending || reloadRequired
    status = {
      ...status,
      pending: pendingNow,
      pendingRevision: pendingNow ? (status.pendingRevision ?? status.desiredRevision) : undefined,
      error,
    }
    return createResultError("caddyApplication", error)
  }

  function startupTrigger(): PromiseResult<CaddyApplicationResult> {
    return trigger(!initializeFromGeneratedConfig, initializeFromGeneratedConfig)
  }

  const application: CaddyApplication = {
    start: async () => {
      if (stopped) return stoppedResult()
      try {
        startInterval()
      } catch {
        return intervalSchedulingFailure()
      }
      return startupTrigger()
    },
    startup: async () => {
      if (stopped) return stoppedResult()
      try {
        startInterval()
      } catch {
        return intervalSchedulingFailure()
      }
      return startupTrigger()
    },
    regenerate: () => trigger(true),
    projectChange: () => trigger(false),
    status: () => caddyApplicationStatusCopy(status),
    stop: () => {
      if (stopPromise !== undefined) return stopPromise
      stopped = true
      pending = undefined
      status = { ...status, error: "Caddy application stopped" }
      if (intervalStarted) {
        try {
          timer.clearInterval(intervalHandle)
        } catch {
          // A failed clear must not keep shutdown waiting.
        }
        intervalHandle = undefined
        intervalStarted = false
      }
      stopController.abort()
      const work = [...triggerOperations].map((operation) => operation.promise)
      for (const operation of triggerOperations) {
        if (operation.settled) continue
        operation.settled = true
        operation.resolve(stoppedResult())
      }
      if (running !== undefined) work.push(running)
      stopPromise = Promise.allSettled(work).then(() => undefined)
      return stopPromise
    },
  }

  return createResult(application)
}
