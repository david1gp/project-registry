import * as v from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { type ProjectAccessLogPage, projectAccessLogPageSchema } from "./projectAccessLogPageSchema.js"

type ProjectAccessLogClientResult = Result<ProjectAccessLogPage> & { code?: string; statusCode?: number; hint?: string }
type ProjectAccessLogFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type ProjectAccessLogTimer = ReturnType<typeof setTimeout>

const projectAccessLogRequestTimeoutMilliseconds = 15_000

function clientError(message: string, code: string, statusCode?: number, hint?: string): ProjectAccessLogClientResult {
  return {
    ...createResultError("projectAccessLogClientGet", message),
    code,
    statusCode,
    ...(hint === undefined ? {} : { hint }),
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

export async function projectAccessLogClientGet(
  owner: string,
  name: string,
  options: { limit?: number; before?: string; signal?: AbortSignal; timeoutMilliseconds?: number } = {},
  requestFetch: ProjectAccessLogFetch = fetch,
): Promise<ProjectAccessLogClientResult> {
  const query = new URLSearchParams()
  if (options.limit !== undefined) query.set("limit", options.limit.toString())
  if (options.before !== undefined) query.set("before", options.before)
  const suffix = query.size === 0 ? "" : `?${query.toString()}`
  const path = `/api/v1/users/${encodeURIComponent(owner)}/projects/${encodeURIComponent(name)}/access-logs${suffix}`

  const controller = new AbortController()
  const timeoutMilliseconds = options.timeoutMilliseconds ?? projectAccessLogRequestTimeoutMilliseconds
  let timeout: ProjectAccessLogTimer | undefined
  let removeExternalAbortListener: (() => void) | undefined
  let removeAbortListener: (() => void) | undefined
  const abortPromise = new Promise<never>((_, reject) => {
    const onAbort = () => reject(new Error("request aborted"))
    controller.signal.addEventListener("abort", onAbort, { once: true })
    removeAbortListener = () => controller.signal.removeEventListener("abort", onAbort)
  })
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = globalThis.setTimeout(() => {
      controller.abort()
      reject(new Error("request timed out"))
    }, timeoutMilliseconds)
  })
  const bounded = <T>(operation: Promise<T>) => Promise.race([operation, abortPromise, timeoutPromise])

  if (options.signal !== undefined) {
    const onExternalAbort = () => controller.abort()
    options.signal.addEventListener("abort", onExternalAbort, { once: true })
    removeExternalAbortListener = () => options.signal?.removeEventListener("abort", onExternalAbort)
    if (options.signal.aborted) controller.abort()
  }

  try {
    let response: Response
    try {
      response = await bounded(
        requestFetch(path, { headers: { accept: "application/json" }, signal: controller.signal }),
      )
    } catch (error) {
      if (controller.signal.aborted || (error instanceof Error && error.name === "AbortError"))
        return clientError("Die Anfrage wurde abgebrochen.", "request.aborted")
      return clientError("Die Zugriffsprotokolle konnten nicht geladen werden.", "request.unavailable")
    }

    let body: unknown
    try {
      body = await bounded(response.json())
    } catch {
      if (controller.signal.aborted) return clientError("Die Anfrage wurde abgebrochen.", "request.aborted")
      return clientError("Der Server hat eine ungültige Antwort gesendet.", "response.malformed", response.status)
    }

    const envelope = recordValue(body)
    if (!response.ok || envelope?.success === false) {
      const error = recordValue(envelope?.error)
      const code = typeof error?.code === "string" ? error.code : "request.unavailable"
      const message =
        typeof error?.message === "string" ? error.message : "Die Zugriffsprotokolle sind nicht verfügbar."
      const hint = typeof error?.hint === "string" ? error.hint : undefined
      return clientError(message, code, response.status, hint)
    }
    if (envelope?.success !== true) {
      return clientError("Der Server hat eine ungültige Antwort gesendet.", "response.malformed", response.status)
    }

    const parsed = v.safeParse(projectAccessLogPageSchema, envelope.data)
    if (!parsed.success) {
      return clientError("Der Server hat ungültige Protokolldaten gesendet.", "response.malformed", response.status)
    }
    return createResult(parsed.output)
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout)
    removeAbortListener?.()
    removeExternalAbortListener?.()
  }
}
