import { types } from "node:util"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyConfigValidateOptions } from "./CaddyConfigValidateOptions.js"
import type { CaddyProcessRunner } from "./CaddyProcessRunner.js"
import type { CaddyTimer } from "./CaddyTimer.js"
import { caddyConfigSerialize } from "./caddyConfigSerialize.js"
import { caddyProcessRun } from "./caddyProcessRun.js"

const defaultTimeoutMs = 30_000

type CaddyConfigValidateProcessResult = {
  exitCode: number
  stdout: string
  stderr: string
}

function caddyConfigValidateTimeoutIsValid(timeoutMs: number | undefined): boolean {
  return timeoutMs === undefined || (Number.isInteger(timeoutMs) && timeoutMs >= 1)
}

function caddyConfigValidateOwnValue(input: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) throw new Error("invalid result")
  return descriptor.value
}

function caddyConfigValidateProcessResultNormalize(value: unknown): CaddyConfigValidateProcessResult | undefined {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value) || types.isProxy(value)) return undefined
    const success = caddyConfigValidateOwnValue(value, "success")
    if (success !== true) return undefined
    const data = caddyConfigValidateOwnValue(value, "data")
    if (typeof data !== "object" || data === null || Array.isArray(data) || types.isProxy(data)) return undefined
    const exitCode = caddyConfigValidateOwnValue(data, "exitCode")
    const stdout = caddyConfigValidateOwnValue(data, "stdout")
    const stderr = caddyConfigValidateOwnValue(data, "stderr")
    if (
      typeof exitCode !== "number" ||
      !Number.isInteger(exitCode) ||
      typeof stdout !== "string" ||
      typeof stderr !== "string"
    ) {
      return undefined
    }
    return { exitCode, stdout, stderr }
  } catch {
    return undefined
  }
}

function caddyConfigValidateOptionsValues(options: unknown): Record<string, unknown> {
  if (options === undefined) return Object.create(null) as Record<string, unknown>
  if (
    typeof options !== "object" ||
    options === null ||
    Array.isArray(options) ||
    types.isProxy(options) ||
    Object.getPrototypeOf(options) !== Object.prototype
  ) {
    throw new Error("invalid options")
  }

  const values: Record<string, unknown> = Object.create(null) as Record<string, unknown>
  for (const key of Reflect.ownKeys(options)) {
    if (typeof key !== "string" || !["caddyBin", "processRunner", "timeoutMs", "signal", "timer"].includes(key)) {
      throw new Error("invalid options")
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid options")
    }
    values[key] = descriptor.value
  }
  return values
}

function caddyConfigValidateOptionsNormalize(
  options: unknown,
  processRunnerOverride: unknown,
): CaddyConfigValidateOptions {
  if (typeof options === "string") {
    if (processRunnerOverride !== undefined && typeof processRunnerOverride !== "function") {
      throw new Error("invalid process runner")
    }
    return { caddyBin: options, processRunner: processRunnerOverride as CaddyProcessRunner | undefined }
  }

  const values = caddyConfigValidateOptionsValues(options)
  const caddyBin = values.caddyBin
  const processRunner = values.processRunner
  const timeoutMs = values.timeoutMs
  const signal = values.signal
  const timer = values.timer

  if (caddyBin !== undefined && typeof caddyBin !== "string") throw new Error("invalid Caddy binary")
  if (processRunner !== undefined && typeof processRunner !== "function") throw new Error("invalid process runner")
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") throw new Error("invalid timeout")
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("invalid signal")
  if (timer !== undefined && (typeof timer !== "object" || timer === null || types.isProxy(timer))) {
    throw new Error("invalid timer")
  }

  return {
    caddyBin: caddyBin as string | undefined,
    processRunner: processRunner as CaddyProcessRunner | undefined,
    timeoutMs: timeoutMs as number | undefined,
    signal: signal as AbortSignal | undefined,
    timer: timer as CaddyTimer | undefined,
  }
}

function caddyConfigValidateTimeoutSchedule(
  timer: CaddyTimer | undefined,
  callback: () => void,
  delayMs: number,
): () => void {
  if (timer?.setTimeout !== undefined) {
    const handle = timer.setTimeout(callback, delayMs)
    return () => timer.clearTimeout?.(handle)
  }

  const handle = globalThis.setTimeout(callback, delayMs)
  return () => globalThis.clearTimeout(handle)
}

export function caddyConfigValidate(
  config: unknown,
  options?: CaddyConfigValidateOptions | string,
  processRunnerOverride?: CaddyProcessRunner,
): PromiseResult<true>
export function caddyConfigValidate(
  config: unknown,
  options?: unknown,
  processRunnerOverride?: unknown,
): PromiseResult<true>
export async function caddyConfigValidate(
  config: unknown,
  options: unknown = {},
  processRunnerOverride?: unknown,
): PromiseResult<true> {
  const op = "caddyConfigValidate"
  let normalizedOptions: CaddyConfigValidateOptions
  try {
    normalizedOptions = caddyConfigValidateOptionsNormalize(options, processRunnerOverride)
  } catch {
    return createResultError(op, "Caddy validate options are invalid")
  }
  if (!caddyConfigValidateTimeoutIsValid(normalizedOptions.timeoutMs)) {
    return createResultError(op, "Caddy validate timeout is invalid")
  }
  const serializedR = caddyConfigSerialize(config)
  if (!serializedR.success) return serializedR

  const processRunner = normalizedOptions.processRunner ?? caddyProcessRun
  const timeoutMs = normalizedOptions.timeoutMs ?? defaultTimeoutMs
  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort()
  try {
    if (normalizedOptions.signal?.aborted) return createResultError(op, "caddy validate cancelled")
    normalizedOptions.signal?.addEventListener("abort", onExternalAbort, { once: true })
  } catch {
    return createResultError(op, "Caddy validate options are invalid")
  }
  let clearTimeout: () => void
  try {
    clearTimeout = caddyConfigValidateTimeoutSchedule(
      normalizedOptions.timer,
      () => {
        timedOut = true
        controller.abort()
      },
      timeoutMs,
    )
  } catch {
    try {
      normalizedOptions.signal?.removeEventListener("abort", onExternalAbort)
    } catch {
      // A malformed cancellation signal must not replace the scheduling result.
    }
    return createResultError(op, "caddy validate timeout scheduling failed")
  }
  if (controller.signal.aborted) {
    try {
      clearTimeout()
    } catch {
      // A timer cleanup failure must not replace cancellation.
    }
    try {
      normalizedOptions.signal?.removeEventListener("abort", onExternalAbort)
    } catch {
      // A malformed cancellation signal must not replace cancellation.
    }
    return createResultError(op, timedOut ? "caddy validate timed out" : "caddy validate cancelled")
  }

  const processPromise = Promise.resolve().then(() =>
    processRunner(
      normalizedOptions.caddyBin ?? "caddy",
      ["validate", "--config", "-", "--adapter", ""],
      serializedR.data,
      { signal: controller.signal, timeoutMs },
    ),
  )
  const cancellationToken = Symbol("caddy validate cancellation")
  let cancellationCleanup: () => void = () => undefined
  const cancellationPromise = new Promise<typeof cancellationToken>((resolve) => {
    const onAbort = () => resolve(cancellationToken)
    if (controller.signal.aborted) {
      onAbort()
      return
    }
    controller.signal.addEventListener("abort", onAbort, { once: true })
    cancellationCleanup = () => controller.signal.removeEventListener("abort", onAbort)
  })

  try {
    const outcome = await Promise.race([processPromise, cancellationPromise])
    if (outcome === cancellationToken) {
      if (processRunner === caddyProcessRun) {
        try {
          await processPromise
        } catch {
          // The process runner owns child cleanup. The public error stays sanitized.
        }
      }
      return createResultError(op, timedOut ? "caddy validate timed out" : "caddy validate cancelled")
    }
    const processResult = caddyConfigValidateProcessResultNormalize(outcome)
    if (processResult === undefined) return createResultError(op, "caddy validate process failed")
    if (processResult.exitCode !== 0) {
      return createResultError(op, `caddy validate failed (exit code ${processResult.exitCode})`)
    }
  } catch {
    return createResultError(op, "caddy validate process failed")
  } finally {
    try {
      clearTimeout()
    } catch {
      // A timer cleanup failure must not replace the operation result.
    }
    cancellationCleanup()
    try {
      normalizedOptions.signal?.removeEventListener("abort", onExternalAbort)
    } catch {
      // A malformed cancellation signal must not replace the operation result.
    }
  }
  return createResult(true)
}
