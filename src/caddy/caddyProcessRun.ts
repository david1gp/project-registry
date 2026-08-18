import { types } from "node:util"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { CaddyProcessRunOptions } from "./CaddyProcessRunOptions.js"

function caddyProcessRunStreamCancel(stream: unknown): void {
  if (typeof stream !== "object" || stream === null || !("cancel" in stream)) return
  const cancel = (stream as { cancel?: () => Promise<void> }).cancel
  if (cancel === undefined) return
  void cancel.call(stream).catch(() => undefined)
}

function caddyProcessRunOptionsNormalize(options: unknown): CaddyProcessRunOptions {
  if (options === undefined) return {}
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
    if (typeof key !== "string" || !["timeoutMs", "signal"].includes(key)) throw new Error("invalid options")
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("invalid options")
    }
    values[key] = descriptor.value
  }

  if (values.timeoutMs !== undefined && typeof values.timeoutMs !== "number") throw new Error("invalid timeout")
  if (values.signal !== undefined && !(values.signal instanceof AbortSignal)) throw new Error("invalid signal")
  return { timeoutMs: values.timeoutMs as number | undefined, signal: values.signal as AbortSignal | undefined }
}

export function caddyProcessRun(
  command: string,
  args: readonly string[],
  input?: string,
  options?: CaddyProcessRunOptions,
): PromiseResult<{ exitCode: number; stdout: string; stderr: string }>
export function caddyProcessRun(
  command: string,
  args: readonly string[],
  input?: string,
  options?: unknown,
): PromiseResult<{ exitCode: number; stdout: string; stderr: string }>
export async function caddyProcessRun(
  command: string,
  args: readonly string[],
  input = "",
  options: unknown = {},
): PromiseResult<{ exitCode: number; stdout: string; stderr: string }> {
  const op = "caddyProcessRun"
  let normalizedOptions: CaddyProcessRunOptions
  try {
    normalizedOptions = caddyProcessRunOptionsNormalize(options)
  } catch {
    return createResultError(op, "Caddy process options are invalid")
  }
  if (
    normalizedOptions.timeoutMs !== undefined &&
    (!Number.isInteger(normalizedOptions.timeoutMs) || normalizedOptions.timeoutMs < 1)
  ) {
    return createResultError(op, "Caddy process timeout is invalid")
  }
  try {
    if (normalizedOptions.signal?.aborted) return createResultError(op, "Caddy process execution cancelled")
  } catch {
    return createResultError(op, "Caddy process options are invalid")
  }

  const controller = new AbortController()
  let cancelled = false
  let timedOut = false
  let child: { kill(signal?: NodeJS.Signals): void; exited: Promise<number> } | undefined
  const onExternalAbort = () => {
    cancelled = true
    controller.abort()
    child?.kill("SIGKILL")
  }
  try {
    normalizedOptions.signal?.addEventListener("abort", onExternalAbort, { once: true })
  } catch {
    return createResultError(op, "Caddy process options are invalid")
  }
  const timeoutHandle =
    normalizedOptions.timeoutMs === undefined
      ? undefined
      : globalThis.setTimeout(() => {
          cancelled = true
          timedOut = true
          controller.abort()
          child?.kill("SIGKILL")
        }, normalizedOptions.timeoutMs)

  try {
    const spawned = Bun.spawn([command, ...args], {
      stdin: new Blob([input]),
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
      killSignal: "SIGKILL",
    })
    child = spawned
    const stdoutPromise = new Response(spawned.stdout).text()
    const stderrPromise = new Response(spawned.stderr).text()
    void stdoutPromise.catch(() => undefined)
    void stderrPromise.catch(() => undefined)
    const exitCode = await spawned.exited
    if (cancelled || controller.signal.aborted) {
      caddyProcessRunStreamCancel(spawned.stdout)
      caddyProcessRunStreamCancel(spawned.stderr)
      return createResultError(op, timedOut ? "Caddy process execution timed out" : "Caddy process execution cancelled")
    }
    const [stdout, stderr] = await Promise.all([stdoutPromise, stderrPromise])
    return createResult({ exitCode, stdout, stderr })
  } catch {
    if (child !== undefined) {
      child.kill("SIGKILL")
      try {
        await child.exited
      } catch {
        // The process runner still returns its sanitized failure below.
      }
    }
    if (cancelled || controller.signal.aborted || normalizedOptions.signal?.aborted) {
      return createResultError(op, timedOut ? "Caddy process execution timed out" : "Caddy process execution cancelled")
    }
    return createResultError(op, "Caddy process execution failed")
  } finally {
    if (timeoutHandle !== undefined) globalThis.clearTimeout(timeoutHandle)
    try {
      normalizedOptions.signal?.removeEventListener("abort", onExternalAbort)
    } catch {
      // A malformed cancellation signal must not replace the operation result.
    }
  }
}
