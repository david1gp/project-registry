import { isIP } from "node:net"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { CloudflareDnsReconcileOptions } from "./CloudflareDnsReconcileOptions.js"
import type { CloudflareDnsReconcileResult } from "./CloudflareDnsReconcileResult.js"
import type { CloudflareDnsRecord } from "./CloudflareDnsRecord.js"

const defaultTimeoutMs = 30_000
const defaultApiBaseUrl = "https://api.cloudflare.com/client/v4"
const nonBlankTextSchema = a.pipe(a.string(), a.regex(/\S/))
const apiEnvelopeSchema = a.object({ success: a.boolean(), result: a.unknown() })
const zoneSchema = a.object({
  id: nonBlankTextSchema,
  name: nonBlankTextSchema,
  status: a.optional(a.string()),
})
const zoneResponseSchema = a.object({ success: a.literal(true), result: a.array(zoneSchema) })
const recordSchema = a.object({
  id: nonBlankTextSchema,
  name: nonBlankTextSchema,
  type: nonBlankTextSchema,
  content: nonBlankTextSchema,
  ttl: a.pipe(a.number(), a.integer(), a.minValue(1)),
  proxied: a.boolean(),
})
const recordListResponseSchema = a.object({ success: a.literal(true), result: a.array(recordSchema) })
const recordResponseSchema = a.object({ success: a.literal(true), result: recordSchema })

type Zone = {
  id: string
  name: string
}

type RequestResponse = {
  status: number
  body: unknown
}

type RequestCancellation = typeof requestCancellation

const requestCancellation = Symbol("cloudflare DNS request cancellation")

function hostnameNormalize(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.trim() !== value) return undefined
  const withoutTrailingDot = value.endsWith(".") ? value.slice(0, -1) : value
  if (withoutTrailingDot.length === 0 || withoutTrailingDot.length > 253 || withoutTrailingDot.includes("..")) {
    return undefined
  }
  const labels = withoutTrailingDot.split(".")
  if (
    labels.some((label) => label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label))
  ) {
    return undefined
  }
  return withoutTrailingDot.toLowerCase()
}

function addressType(value: string): "A" | "AAAA" | undefined {
  const type = isIP(value)
  if (type === 4) return "A"
  if (type === 6) return "AAAA"
  return undefined
}

function addressComparable(value: string): string {
  if (isIP(value) !== 6) return value
  try {
    return new URL(`http://[${value}]`).hostname.toLowerCase().replace(/^\[|\]$/g, "")
  } catch {
    return value.toLowerCase()
  }
}

function addressMatches(left: string, right: string): boolean {
  return addressComparable(left) === addressComparable(right)
}

function mutationRecordIsExpected(
  record: CloudflareDnsRecord,
  hostname: string,
  recordType: "A" | "AAAA",
  address: string,
  id?: string,
): boolean {
  return (
    (id === undefined || record.id === id) &&
    hostnameNormalize(record.name) === hostname &&
    record.type.toUpperCase() === recordType &&
    addressMatches(record.content, address) &&
    record.ttl === 1 &&
    record.proxied === false
  )
}

function candidateZoneNames(hostname: string): string[] {
  const labels = hostname.split(".")
  return labels.map((_label, index) => labels.slice(index).join("."))
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

function apiResponseParse<TSchema extends a.BaseSchema<unknown, unknown, a.BaseIssue<unknown>>>(
  body: unknown,
  schema: TSchema,
): Result<a.InferOutput<TSchema>> {
  const envelopeR = a.safeParse(apiEnvelopeSchema, body)
  if (!envelopeR.success || !envelopeR.output.success)
    return createResultError("cloudflareDnsReconcile", "Cloudflare API response was invalid")
  const parsedR = a.safeParse(schema, body)
  if (!parsedR.success) return createResultError("cloudflareDnsReconcile", "Cloudflare API response was invalid")
  return createResult(parsedR.output)
}

export async function cloudflareDnsReconcile(
  options: CloudflareDnsReconcileOptions,
): PromiseResult<CloudflareDnsReconcileResult> {
  const op = "cloudflareDnsReconcile"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Cloudflare DNS options are required")
  if (typeof options.token !== "string" || options.token.length === 0 || options.token.trim() !== options.token) {
    return createResultError(op, "Cloudflare API token is invalid")
  }
  const hostname = hostnameNormalize(options.hostname)
  if (hostname === undefined) return createResultError(op, "Cloudflare DNS hostname is invalid")
  if (typeof options.address !== "string" || options.address.trim() !== options.address) {
    return createResultError(op, "Cloudflare DNS address is invalid")
  }
  const recordType = addressType(options.address)
  if (recordType === undefined) return createResultError(op, "Cloudflare DNS address is invalid")
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
  if (options.signal?.aborted) return createResultError(op, "Cloudflare DNS reconciliation cancelled")
  options.signal?.addEventListener("abort", onExternalAbort, { once: true })
  const timeoutHandle = globalThis.setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  async function request(path: string, init: RequestInit): Promise<Result<RequestResponse>> {
    if (controller.signal.aborted) {
      return createResultError(
        op,
        timedOut ? "Cloudflare DNS reconciliation timed out" : "Cloudflare DNS reconciliation cancelled",
      )
    }
    const requestPromise = Promise.resolve()
      .then(() => fetcher(`${apiBase.origin}${apiBase.pathname}${path}`, { ...init, signal: controller.signal }))
      .then(async (response): Promise<RequestResponse> => {
        if (!responseIsValid(response)) throw new Error("invalid response")
        const text = await response.text()
        let body: unknown
        try {
          body = JSON.parse(text)
        } catch {
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
          timedOut ? "Cloudflare DNS reconciliation timed out" : "Cloudflare DNS reconciliation cancelled",
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

  try {
    let zone: Zone | undefined
    for (const candidate of candidateZoneNames(hostname)) {
      const zoneUrl = new URL(`${apiBase.origin}${apiBase.pathname}/zones`)
      zoneUrl.searchParams.set("name", candidate)
      zoneUrl.searchParams.set("per_page", "50")
      const responseR = await request(`/zones${zoneUrl.search}`, { method: "GET", headers })
      if (!responseR.success) return responseR
      if (responseR.data.status < 200 || responseR.data.status >= 300) {
        return createResultError(op, `Cloudflare DNS request failed (status ${responseR.data.status})`)
      }
      const parsedR = apiResponseParse(responseR.data.body, zoneResponseSchema)
      if (!parsedR.success) return parsedR
      const zones = parsedR.data.result
        .filter((entry) => hostnameNormalize(entry.name) === candidate)
        .map((entry) => ({ id: entry.id, name: hostnameNormalize(entry.name) ?? entry.name }))
      if (zones.length > 1) return createResultError(op, `Cloudflare DNS zone lookup is ambiguous for ${candidate}`)
      zone = zones[0]
      if (zone !== undefined) break
    }
    if (zone === undefined) return createResultError(op, `No accessible Cloudflare DNS zone matches ${hostname}`)

    const recordsUrl = new URL(`${apiBase.origin}${apiBase.pathname}/zones/${encodeURIComponent(zone.id)}/dns_records`)
    recordsUrl.searchParams.set("name", hostname)
    recordsUrl.searchParams.set("per_page", "1000")
    const recordsResponseR = await request(`/zones/${encodeURIComponent(zone.id)}/dns_records${recordsUrl.search}`, {
      method: "GET",
      headers,
    })
    if (!recordsResponseR.success) return recordsResponseR
    if (recordsResponseR.data.status < 200 || recordsResponseR.data.status >= 300) {
      return createResultError(op, `Cloudflare DNS request failed (status ${recordsResponseR.data.status})`)
    }
    const recordsParsedR = apiResponseParse(recordsResponseR.data.body, recordListResponseSchema)
    if (!recordsParsedR.success) return recordsParsedR
    const exactRecords = recordsParsedR.data.result.filter((record) => hostnameNormalize(record.name) === hostname)
    const cnameRecords = exactRecords.filter((record) => record.type.toUpperCase() === "CNAME")
    if (cnameRecords.length > 0) {
      return createResultError(op, `Cloudflare DNS record ${hostname} has an incompatible CNAME`, `cname:${hostname}`)
    }
    const matchingRecords = exactRecords.filter((record) => record.type.toUpperCase() === recordType)
    if (matchingRecords.length > 1) {
      return createResultError(
        op,
        `Cloudflare DNS record ${hostname} has ambiguous ${recordType} records`,
        `multiple:${hostname}:${recordType}`,
      )
    }

    const currentRecord = matchingRecords[0]
    const desiredRecord = {
      type: recordType,
      name: hostname,
      content: options.address,
      ttl: 1,
      proxied: false,
    }
    if (currentRecord !== undefined) {
      if (
        addressMatches(currentRecord.content, options.address) &&
        currentRecord.proxied === desiredRecord.proxied &&
        currentRecord.ttl === desiredRecord.ttl
      ) {
        return createResult({ action: "skipped", zone, record: currentRecord })
      }
      const updatePath = `/zones/${encodeURIComponent(zone.id)}/dns_records/${encodeURIComponent(currentRecord.id)}`
      const updateResponseR = await request(updatePath, {
        method: "PUT",
        headers,
        body: JSON.stringify(desiredRecord),
      })
      if (!updateResponseR.success) return updateResponseR
      if (updateResponseR.data.status < 200 || updateResponseR.data.status >= 300) {
        return createResultError(op, `Cloudflare DNS request failed (status ${updateResponseR.data.status})`)
      }
      const updatedParsedR = apiResponseParse(updateResponseR.data.body, recordResponseSchema)
      if (!updatedParsedR.success) return updatedParsedR
      const updatedRecord = updatedParsedR.data.result as CloudflareDnsRecord
      if (!mutationRecordIsExpected(updatedRecord, hostname, recordType, options.address, currentRecord.id)) {
        return createResultError(op, "Cloudflare DNS update response was invalid")
      }
      return createResult({ action: "updated", zone, record: updatedRecord })
    }

    const createUrl = `/zones/${encodeURIComponent(zone.id)}/dns_records`
    const createResponseR = await request(createUrl, {
      method: "POST",
      headers,
      body: JSON.stringify(desiredRecord),
    })
    if (!createResponseR.success) return createResponseR
    if (createResponseR.data.status < 200 || createResponseR.data.status >= 300) {
      return createResultError(op, `Cloudflare DNS request failed (status ${createResponseR.data.status})`)
    }
    const createdParsedR = apiResponseParse(createResponseR.data.body, recordResponseSchema)
    if (!createdParsedR.success) return createdParsedR
    const createdRecord = createdParsedR.data.result as CloudflareDnsRecord
    if (!mutationRecordIsExpected(createdRecord, hostname, recordType, options.address)) {
      return createResultError(op, "Cloudflare DNS create response was invalid")
    }
    return createResult({ action: "created", zone, record: createdRecord })
  } catch {
    return createResultError(op, "Cloudflare DNS request failed")
  } finally {
    globalThis.clearTimeout(timeoutHandle)
    options.signal?.removeEventListener("abort", onExternalAbort)
  }
}
