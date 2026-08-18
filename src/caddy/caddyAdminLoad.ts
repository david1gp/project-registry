import { types } from "node:util"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyAdminLoadOptions } from "./CaddyAdminLoadOptions.js"
import type { CaddyFetch } from "./CaddyFetch.js"
import type { CaddyTimer } from "./CaddyTimer.js"
import { caddyConfigSerialize } from "./caddyConfigSerialize.js"

const defaultTimeoutMs = 30_000

type CaddyAdminLoadResponse = {
  ok: boolean
  status: number
}

function caddyAdminLoadTimeoutIsValid(timeoutMs: number | undefined): boolean {
  return timeoutMs === undefined || (Number.isInteger(timeoutMs) && timeoutMs >= 1)
}

function caddyAdminLoadResponseNormalize(value: unknown): CaddyAdminLoadResponse | undefined {
  try {
    if (typeof value !== "object" || value === null || types.isProxy(value)) return undefined

    let ok: unknown
    let status: unknown
    if (typeof Response === "function" && Object.getPrototypeOf(value) === Response.prototype) {
      ok = (value as Response).ok
      status = (value as Response).status
    } else {
      const okDescriptor = Object.getOwnPropertyDescriptor(value, "ok")
      const statusDescriptor = Object.getOwnPropertyDescriptor(value, "status")
      if (
        okDescriptor === undefined ||
        !("value" in okDescriptor) ||
        !okDescriptor.enumerable ||
        statusDescriptor === undefined ||
        !("value" in statusDescriptor) ||
        !statusDescriptor.enumerable
      ) {
        return undefined
      }
      ok = okDescriptor.value
      status = statusDescriptor.value
    }

    if (
      typeof ok !== "boolean" ||
      typeof status !== "number" ||
      !Number.isInteger(status) ||
      status < 100 ||
      status > 599
    ) {
      return undefined
    }
    if (ok !== (status >= 200 && status < 300)) return undefined
    return { ok, status }
  } catch {
    return undefined
  }
}

function caddyAdminLoadOptionsValues(options: unknown): Record<string, unknown> {
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
    if (typeof key !== "string" || !["adminUrl", "fetch", "timeoutMs", "signal", "timer"].includes(key)) {
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

function caddyAdminLoadOptionsNormalize(options: unknown, fetchOverride: unknown): CaddyAdminLoadOptions {
  if (typeof options === "string") {
    if (fetchOverride !== undefined && typeof fetchOverride !== "function") throw new Error("invalid fetch")
    return { adminUrl: options, fetch: fetchOverride as CaddyFetch | undefined }
  }

  const values = caddyAdminLoadOptionsValues(options)
  const adminUrl = values.adminUrl
  const fetch = values.fetch
  const timeoutMs = values.timeoutMs
  const signal = values.signal
  const timer = values.timer

  if (adminUrl !== undefined && typeof adminUrl !== "string") throw new Error("invalid admin URL")
  if (fetch !== undefined && typeof fetch !== "function") throw new Error("invalid fetch")
  if (timeoutMs !== undefined && typeof timeoutMs !== "number") throw new Error("invalid timeout")
  if (signal !== undefined && !(signal instanceof AbortSignal)) throw new Error("invalid signal")
  if (timer !== undefined && (typeof timer !== "object" || timer === null || types.isProxy(timer))) {
    throw new Error("invalid timer")
  }

  return {
    adminUrl: adminUrl as string | undefined,
    fetch: fetch as CaddyFetch | undefined,
    timeoutMs: timeoutMs as number | undefined,
    signal: signal as AbortSignal | undefined,
    timer: timer as CaddyTimer | undefined,
  }
}

function caddyAdminLoadTimeoutSchedule(
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

export function caddyAdminLoad(
  config: unknown,
  options?: CaddyAdminLoadOptions | string,
  fetchOverride?: CaddyFetch,
): PromiseResult<true>
export function caddyAdminLoad(config: unknown, options?: unknown, fetchOverride?: unknown): PromiseResult<true>
export async function caddyAdminLoad(
  config: unknown,
  options: unknown = {},
  fetchOverride?: unknown,
): PromiseResult<true> {
  const op = "caddyAdminLoad"
  let normalizedOptions: CaddyAdminLoadOptions
  try {
    normalizedOptions = caddyAdminLoadOptionsNormalize(options, fetchOverride)
  } catch {
    return createResultError(op, "Caddy admin load options are invalid")
  }
  if (!caddyAdminLoadTimeoutIsValid(normalizedOptions.timeoutMs)) {
    return createResultError(op, "Caddy admin load timeout is invalid")
  }
  const serializedR = caddyConfigSerialize(config)
  if (!serializedR.success) return serializedR

  const adminUrl = (normalizedOptions.adminUrl ?? "http://localhost:2019").replace(/\/+$/, "")
  const fetcher = normalizedOptions.fetch ?? globalThis.fetch
  if (typeof fetcher !== "function") return createResultError(op, "Caddy admin load fetch is invalid")
  const timeoutMs = normalizedOptions.timeoutMs ?? defaultTimeoutMs
  const controller = new AbortController()
  let timedOut = false
  const onExternalAbort = () => controller.abort()
  try {
    if (normalizedOptions.signal?.aborted) return createResultError(op, "caddy admin load cancelled")
    normalizedOptions.signal?.addEventListener("abort", onExternalAbort, { once: true })
  } catch {
    return createResultError(op, "caddy admin load options are invalid")
  }
  let clearTimeout: () => void
  try {
    clearTimeout = caddyAdminLoadTimeoutSchedule(
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
    return createResultError(op, "caddy admin load timeout scheduling failed")
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
    return createResultError(op, timedOut ? "caddy admin load timed out" : "caddy admin load cancelled")
  }

  const fetchPromise = Promise.resolve().then(() =>
    fetcher(`${adminUrl}/load`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "cache-control": "must-revalidate",
      },
      body: serializedR.data,
      signal: controller.signal,
    }),
  )
  const cancellationToken = Symbol("caddy admin load cancellation")
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
    const outcome = await Promise.race([fetchPromise, cancellationPromise])
    if (outcome === cancellationToken) {
      return createResultError(op, timedOut ? "caddy admin load timed out" : "caddy admin load cancelled")
    }
    const response = caddyAdminLoadResponseNormalize(outcome)
    if (response === undefined) return createResultError(op, "caddy admin load request failed")
    if (!response.ok) return createResultError(op, `caddy admin load failed (status ${response.status})`)
    return createResult(true)
  } catch {
    return createResultError(op, "caddy admin load request failed")
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
}
