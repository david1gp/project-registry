import { createResult, createResultError, type PromiseResult } from "#result"
import { promiseBoundedRace } from "../runtime/promiseBoundedRace.js"
import type { ZitadelHttp } from "./ZitadelHttp.js"
import type { ZitadelHttpOptions } from "./ZitadelHttpOptions.js"

const defaultBodyBytes = 1_048_576
const maximumBodyBytes = 8_388_608

function bodyBytesIsValid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= maximumBodyBytes
}

function responseIsValid(value: unknown): value is Response {
  return typeof value === "object" && value !== null && typeof (value as { ok?: unknown }).ok === "boolean"
}

function contentLengthResolve(response: Response, maxBodyBytes: number): boolean {
  try {
    const contentLength = response.headers?.get("content-length")
    if (contentLength === null || contentLength === undefined || contentLength === "") return true
    if (!/^\d+$/.test(contentLength)) return false
    const length = Number(contentLength)
    return Number.isSafeInteger(length) && length <= maxBodyBytes
  } catch {
    return false
  }
}

async function responseBodyRead(response: Response, maxBodyBytes: number): Promise<string> {
  if (!contentLengthResolve(response, maxBodyBytes)) throw new Error("response body is too large")
  if (response.body !== null && response.body !== undefined) {
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const part = await reader.read()
        if (part.done) break
        if (!(part.value instanceof Uint8Array)) throw new Error("response body is invalid")
        size += part.value.byteLength
        if (!Number.isSafeInteger(size) || size > maxBodyBytes) throw new Error("response body is too large")
        chunks.push(part.value)
      }
    } finally {
      if (size > maxBodyBytes) await reader.cancel().catch(() => undefined)
    }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return new TextDecoder().decode(bytes)
  }
  if (typeof response.text !== "function") throw new Error("response body is unavailable")
  const text = await response.text()
  if (typeof text !== "string") throw new Error("response body is invalid")
  const size = new TextEncoder().encode(text).byteLength
  if (!Number.isSafeInteger(size) || size > maxBodyBytes) throw new Error("response body is too large")
  return text
}

export async function zitadelHttpJsonFetch(
  http: ZitadelHttp,
  input: string,
  init: RequestInit,
  options: ZitadelHttpOptions = {},
): PromiseResult<{ response: Response; body: unknown }> {
  const op = "zitadelHttpJsonFetch"
  if (typeof http !== "function") return createResultError(op, "Zitadel HTTP dependency is invalid")
  const timeoutMs = options.timeoutMs
  const maxBodyBytes = options.maxBodyBytes ?? defaultBodyBytes
  if (
    (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000)) ||
    !bodyBytesIsValid(maxBodyBytes) ||
    (options.signal !== undefined && !(typeof AbortSignal === "function" && options.signal instanceof AbortSignal))
  ) {
    return createResultError(op, "Zitadel HTTP options are invalid")
  }
  if (options.signal?.aborted) return createResultError(op, "Zitadel HTTP request was cancelled")
  const controller = new AbortController()
  const onAbort = () => controller.abort()
  try {
    options.signal?.addEventListener("abort", onAbort, { once: true })
  } catch {
    return createResultError(op, "Zitadel HTTP options are invalid")
  }
  const request = Promise.resolve().then(async () => {
    const response = await http(input, { ...init, signal: controller.signal })
    if (!responseIsValid(response)) throw new Error("Zitadel HTTP response is invalid")
    if (!response.ok) return { response, body: undefined }
    const bodyText = await responseBodyRead(response, maxBodyBytes)
    let body: unknown
    try {
      body = JSON.parse(bodyText) as unknown
    } catch {
      throw new Error("Zitadel HTTP response is not JSON")
    }
    return { response, body }
  })
  const result = await promiseBoundedRace(request, { timeoutMs, signal: options.signal })
  try {
    if (!result.success) {
      if (result.errorMessage.includes("timed out")) controller.abort()
      return createResultError(op, result.errorMessage)
    }
    return createResult(result.data)
  } finally {
    options.signal?.removeEventListener("abort", onAbort)
    controller.abort()
  }
}
