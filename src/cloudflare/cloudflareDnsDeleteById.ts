import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { CloudflareDnsDeleteByIdOptions } from "./CloudflareDnsDeleteByIdOptions.js"
import type { CloudflareDnsDeleteByIdResult } from "./CloudflareDnsDeleteByIdResult.js"
import type { CloudflareDnsRecord } from "./CloudflareDnsRecord.js"
import { cloudflareDnsTrackedRecordSchema } from "./CloudflareDnsTrackedRecord.js"

const defaultTimeoutMs = 30_000
const defaultApiBaseUrl = "https://api.cloudflare.com/client/v4"
const nonBlankTextSchema = a.pipe(a.string(), a.regex(/\S/))
const apiEnvelopeSchema = a.object({ success: a.boolean(), result: a.unknown() })
const recordSchema = a.object({
  id: nonBlankTextSchema,
  name: nonBlankTextSchema,
  type: nonBlankTextSchema,
  content: nonBlankTextSchema,
  ttl: a.pipe(a.number(), a.integer(), a.minValue(1)),
  proxied: a.boolean(),
})
const recordResponseSchema = a.object({ success: a.literal(true), result: recordSchema })
const deleteResponseSchema = a.object({ success: a.literal(true), result: a.unknown() })

type RequestResponse = {
  status: number
  body: unknown
}

type RequestCancellation = typeof requestCancellation

const requestCancellation = Symbol("cloudflare DNS delete request cancellation")

function hostnameNormalize(value: string): string {
  return value.endsWith(".") ? value.slice(0, -1).toLowerCase() : value.toLowerCase()
}

function responseIsValid(response: unknown): response is Response {
  if (typeof response !== "object" || response === null) return false
  const candidate = response as { ok?: unknown; status?: unknown; text?: unknown }
  return (
    typeof candidate.ok === "boolean" &&
    typeof candidate.status === "number" &&
    Number.isInteger(candidate.status) &&
    candidate.status >= 100 &&
    candidate.status <= 599 &&
    candidate.ok === (candidate.status >= 200 && candidate.status < 300) &&
    typeof candidate.text === "function"
  )
}

function apiResponseIsSuccessful(body: unknown, schema: a.BaseSchema<unknown, unknown, a.BaseIssue<unknown>>): boolean {
  const envelopeR = a.safeParse(apiEnvelopeSchema, body)
  if (!envelopeR.success || !envelopeR.output.success) return false
  return a.safeParse(schema, body).success
}

function trackedRecordMatches(current: CloudflareDnsRecord, tracked: CloudflareDnsRecord): boolean {
  return (
    current.id === tracked.id &&
    hostnameNormalize(current.name) === hostnameNormalize(tracked.name) &&
    current.type.toUpperCase() === tracked.type.toUpperCase() &&
    current.content === tracked.content &&
    current.proxied === tracked.proxied &&
    current.ttl === tracked.ttl
  )
}

export async function cloudflareDnsDeleteById(
  options: CloudflareDnsDeleteByIdOptions,
): PromiseResult<CloudflareDnsDeleteByIdResult> {
  const op = "cloudflareDnsDeleteById"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Cloudflare DNS options are required")
  if (typeof options.token !== "string" || options.token.length === 0 || options.token.trim() !== options.token) {
    return createResultError(op, "Cloudflare API token is invalid")
  }
  const trackedR = a.safeParse(cloudflareDnsTrackedRecordSchema, options.record)
  if (!trackedR.success) return createResultError(op, "Cloudflare tracked DNS record is invalid")
  const tracked = trackedR.output
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1)) {
    return createResultError(op, "Cloudflare DNS timeout is invalid")
  }
  if (options.signal !== undefined && !(options.signal instanceof AbortSignal)) {
    return createResultError(op, "Cloudflare DNS cancellation signal is invalid")
  }
  if (options.fetch !== undefined && typeof options.fetch !== "function") {
    return createResultError(op, "Cloudflare DNS fetch is invalid")
  }

  const apiBaseUrl = options.apiBaseUrl ?? defaultApiBaseUrl
  let apiBase: URL
  try {
    apiBase = new URL(apiBaseUrl)
  } catch {
    return createResultError(op, "Cloudflare DNS API URL is invalid")
  }
  if (
    apiBase.protocol !== "https:" ||
    apiBase.username !== "" ||
    apiBase.password !== "" ||
    apiBase.search !== "" ||
    apiBase.hash !== ""
  ) {
    return createResultError(op, "Cloudflare DNS API URL is invalid")
  }
  apiBase.pathname = apiBase.pathname.replace(/\/+$/, "")
  const fetcher = options.fetch ?? globalThis.fetch
  if (typeof fetcher !== "function") return createResultError(op, "Cloudflare DNS fetch is unavailable")

  const controller = new AbortController()
  let timedOut = false
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs
  const onExternalAbort = () => controller.abort()
  if (options.signal?.aborted) return createResultError(op, "Cloudflare DNS deletion cancelled")
  options.signal?.addEventListener("abort", onExternalAbort, { once: true })
  const timeoutHandle = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  async function request(path: string, init: RequestInit): Promise<Result<RequestResponse>> {
    if (controller.signal.aborted) {
      return createResultError(op, timedOut ? "Cloudflare DNS deletion timed out" : "Cloudflare DNS deletion cancelled")
    }
    const requestPromise = Promise.resolve()
      .then(() => fetcher(`${apiBase.origin}${apiBase.pathname}${path}`, { ...init, signal: controller.signal }))
      .then(async (response): Promise<RequestResponse> => {
        if (!responseIsValid(response)) throw new Error("invalid response")
        const text = await response.text()
        if (text.trim() === "") return { status: response.status, body: undefined }
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
          if (response.status === 404) return { status: response.status, body: undefined }
          throw new Error("invalid JSON")
        }
        return { status: response.status, body }
      })
    requestPromise.catch(() => undefined)
    let cancellationCleanup: () => void = () => undefined
    const cancellationPromise = new Promise<RequestCancellation>((resolve) => {
      const onAbort = () => resolve(requestCancellation)
      if (controller.signal.aborted) {
        onAbort()
        return
      }
      controller.signal.addEventListener("abort", onAbort, { once: true })
      cancellationCleanup = () => controller.signal.removeEventListener("abort", onAbort)
    })
    try {
      const response = await Promise.race([requestPromise, cancellationPromise])
      if (response === requestCancellation) {
        return createResultError(
          op,
          timedOut ? "Cloudflare DNS deletion timed out" : "Cloudflare DNS deletion cancelled",
        )
      }
      return createResult(response)
    } catch {
      return createResultError(op, "Cloudflare DNS request failed")
    } finally {
      cancellationCleanup()
    }
  }

  const headers = {
    accept: "application/json",
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  }
  const recordPath = `/zones/${encodeURIComponent(tracked.zoneId)}/dns_records/${encodeURIComponent(tracked.id)}`

  try {
    const currentResponseR = await request(recordPath, { method: "GET", headers })
    if (!currentResponseR.success) return currentResponseR
    if (currentResponseR.data.status === 404) return createResult({ action: "absent", recordId: tracked.id })
    if (currentResponseR.data.status < 200 || currentResponseR.data.status >= 300) {
      return createResultError(op, `Cloudflare DNS request failed (status ${currentResponseR.data.status})`)
    }
    if (!apiResponseIsSuccessful(currentResponseR.data.body, recordResponseSchema)) {
      return createResultError(op, "Cloudflare DNS verification response was invalid")
    }
    const currentBodyR = a.safeParse(recordResponseSchema, currentResponseR.data.body)
    if (!currentBodyR.success) return createResultError(op, "Cloudflare DNS verification response was invalid")
    const currentBody = currentBodyR.output
    if (!trackedRecordMatches(currentBody.result, tracked)) {
      return createResultError(op, "Cloudflare DNS tracked record verification failed")
    }

    const deleteResponseR = await request(recordPath, { method: "DELETE", headers })
    if (!deleteResponseR.success) return deleteResponseR
    if (deleteResponseR.data.status === 404) return createResult({ action: "absent", recordId: tracked.id })
    if (deleteResponseR.data.status < 200 || deleteResponseR.data.status >= 300) {
      return createResultError(op, `Cloudflare DNS request failed (status ${deleteResponseR.data.status})`)
    }
    if (deleteResponseR.data.status === 204) return createResult({ action: "deleted", recordId: tracked.id })
    if (!apiResponseIsSuccessful(deleteResponseR.data.body, deleteResponseSchema)) {
      return createResultError(op, "Cloudflare DNS delete response was invalid")
    }
    return createResult({ action: "deleted", recordId: tracked.id })
  } catch {
    return createResultError(op, "Cloudflare DNS request failed")
  } finally {
    globalThis.clearTimeout(timeoutHandle)
    options.signal?.removeEventListener("abort", onExternalAbort)
  }
}
