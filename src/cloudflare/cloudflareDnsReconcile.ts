import { isIP } from "node:net"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult, type Result, type ResultErr } from "#result"
import type { CloudflareDnsReconcileOptions } from "./CloudflareDnsReconcileOptions.js"
import type { CloudflareDnsReconcileResult } from "./CloudflareDnsReconcileResult.js"
import type { CloudflareDnsRecord } from "./CloudflareDnsRecord.js"
import type { CloudflareDnsOperation } from "./cloudflareDnsOperationSchema.js"
import { cloudflareDnsErrorDataCreate } from "./cloudflareDnsErrorDataCreate.js"

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

const operationLabels: Record<CloudflareDnsOperation, string> = {
  "zone-lookup": "zone lookup",
  "record-list": "DNS record list",
  "record-create": "DNS record creation",
  "record-update": "DNS record update",
  "record-verify": "DNS record verification",
  "record-delete": "DNS record deletion",
  request: "request",
}

function dnsFailureCreate(
  op: string,
  operation: CloudflareDnsOperation,
  message: string,
  status?: number,
  body?: unknown,
): ResultErr {
  const error = createResultError(op, message, cloudflareDnsErrorDataCreate({ operation, statusCode: status, body }))
  if (typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599) {
    error.statusCode = status
  }
  return error
}

function dnsHttpMessageFor(status: number): string {
  if (status === 401) return "Cloudflare API token is invalid or expired (status 401)"
  if (status === 403) return "Cloudflare API token lacks Zone Read or DNS Edit permission (status 403)"
  if (status === 429) return "Cloudflare API rate limit exceeded; retry later (status 429)"
  return `Cloudflare DNS request failed (status ${status})`
}

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

function envelopeIsSuccessful(body: unknown): boolean {
  const envelopeR = a.safeParse(apiEnvelopeSchema, body)
  return envelopeR.success && envelopeR.output.success === true
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

  async function request(
    path: string,
    init: RequestInit,
    operation: CloudflareDnsOperation,
  ): Promise<Result<RequestResponse>> {
    if (controller.signal.aborted) {
      return dnsFailureCreate(
        op,
        operation,
        timedOut ? "Cloudflare DNS reconciliation timed out" : "Cloudflare DNS reconciliation cancelled",
      )
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
          return { status: response.status, body: undefined }
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
        return dnsFailureCreate(
          op,
          operation,
          timedOut ? "Cloudflare DNS reconciliation timed out" : "Cloudflare DNS reconciliation cancelled",
        )
      }
      return createResult(response)
    } catch {
      return dnsFailureCreate(op, operation, "Cloudflare DNS request failed")
    } finally {
      cancellationCleanup()
    }
  }

  function httpErrorFor(operation: CloudflareDnsOperation, status: number, body: unknown): ResultErr {
    return dnsFailureCreate(op, operation, dnsHttpMessageFor(status), status, body)
  }

  function envelopeErrorFor(operation: CloudflareDnsOperation, status: number, body: unknown): ResultErr {
    return dnsFailureCreate(
      op,
      operation,
      `Cloudflare API reported an error during ${operationLabels[operation]}`,
      status,
      body,
    )
  }

  function invalidResponseErrorFor(operation: CloudflareDnsOperation, status: number): ResultErr {
    return dnsFailureCreate(op, operation, "Cloudflare API response was invalid", status)
  }

  const headers = {
    accept: "application/json",
    authorization: `Bearer ${options.token}`,
    "content-type": "application/json",
  }

  try {
    let zone: Zone | undefined
    let zoneLookupStatus: number | undefined
    for (const candidate of candidateZoneNames(hostname)) {
      const zoneUrl = new URL(`${apiBase.origin}${apiBase.pathname}/zones`)
      zoneUrl.searchParams.set("name", candidate)
      zoneUrl.searchParams.set("per_page", "50")
      const responseR = await request(`/zones${zoneUrl.search}`, { method: "GET", headers }, "zone-lookup")
      if (!responseR.success) return responseR
      zoneLookupStatus = responseR.data.status
      if (responseR.data.status < 200 || responseR.data.status >= 300) {
        return httpErrorFor("zone-lookup", responseR.data.status, responseR.data.body)
      }
      if (!envelopeIsSuccessful(responseR.data.body)) {
        return envelopeErrorFor("zone-lookup", responseR.data.status, responseR.data.body)
      }
      const parsedR = a.safeParse(zoneResponseSchema, responseR.data.body)
      if (!parsedR.success) return invalidResponseErrorFor("zone-lookup", responseR.data.status)
      const zones = parsedR.output.result
        .filter((entry) => hostnameNormalize(entry.name) === candidate)
        .map((entry) => ({ id: entry.id, name: hostnameNormalize(entry.name) ?? entry.name }))
      if (zones.length > 1)
        return dnsFailureCreate(
          op,
          "zone-lookup",
          `Cloudflare DNS zone lookup is ambiguous for ${candidate}`,
          responseR.data.status,
        )
      zone = zones[0]
      if (zone !== undefined) break
    }
    if (zone === undefined)
      return dnsFailureCreate(
        op,
        "zone-lookup",
        `No accessible Cloudflare DNS zone matches ${hostname}`,
        zoneLookupStatus,
      )

    const recordsUrl = new URL(`${apiBase.origin}${apiBase.pathname}/zones/${encodeURIComponent(zone.id)}/dns_records`)
    recordsUrl.searchParams.set("name", hostname)
    recordsUrl.searchParams.set("per_page", "1000")
    const recordsResponseR = await request(
      `/zones/${encodeURIComponent(zone.id)}/dns_records${recordsUrl.search}`,
      {
        method: "GET",
        headers,
      },
      "record-list",
    )
    if (!recordsResponseR.success) return recordsResponseR
    if (recordsResponseR.data.status < 200 || recordsResponseR.data.status >= 300) {
      return httpErrorFor("record-list", recordsResponseR.data.status, recordsResponseR.data.body)
    }
    if (!envelopeIsSuccessful(recordsResponseR.data.body)) {
      return envelopeErrorFor("record-list", recordsResponseR.data.status, recordsResponseR.data.body)
    }
    const recordsParsedR = a.safeParse(recordListResponseSchema, recordsResponseR.data.body)
    if (!recordsParsedR.success) return invalidResponseErrorFor("record-list", recordsResponseR.data.status)
    const exactRecords = recordsParsedR.output.result.filter((record) => hostnameNormalize(record.name) === hostname)
    const cnameRecords = exactRecords.filter((record) => record.type.toUpperCase() === "CNAME")
    if (cnameRecords.length > 0) {
      return dnsFailureCreate(
        op,
        "record-list",
        `Cloudflare DNS record ${hostname} has an incompatible CNAME`,
        recordsResponseR.data.status,
      )
    }
    const matchingRecords = exactRecords.filter((record) => record.type.toUpperCase() === recordType)
    if (matchingRecords.length > 1) {
      return dnsFailureCreate(
        op,
        "record-list",
        `Cloudflare DNS record ${hostname} has ambiguous ${recordType} records`,
        recordsResponseR.data.status,
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
      const updateResponseR = await request(
        updatePath,
        {
          method: "PUT",
          headers,
          body: JSON.stringify(desiredRecord),
        },
        "record-update",
      )
      if (!updateResponseR.success) return updateResponseR
      if (updateResponseR.data.status < 200 || updateResponseR.data.status >= 300) {
        return httpErrorFor("record-update", updateResponseR.data.status, updateResponseR.data.body)
      }
      if (!envelopeIsSuccessful(updateResponseR.data.body)) {
        return envelopeErrorFor("record-update", updateResponseR.data.status, updateResponseR.data.body)
      }
      const updatedParsedR = a.safeParse(recordResponseSchema, updateResponseR.data.body)
      if (!updatedParsedR.success) return invalidResponseErrorFor("record-update", updateResponseR.data.status)
      const updatedRecord = updatedParsedR.output.result as CloudflareDnsRecord
      if (!mutationRecordIsExpected(updatedRecord, hostname, recordType, options.address, currentRecord.id)) {
        return dnsFailureCreate(
          op,
          "record-update",
          "Cloudflare DNS update response was invalid",
          updateResponseR.data.status,
        )
      }
      return createResult({ action: "updated", zone, record: updatedRecord })
    }

    const createUrl = `/zones/${encodeURIComponent(zone.id)}/dns_records`
    const createResponseR = await request(
      createUrl,
      {
        method: "POST",
        headers,
        body: JSON.stringify(desiredRecord),
      },
      "record-create",
    )
    if (!createResponseR.success) return createResponseR
    if (createResponseR.data.status < 200 || createResponseR.data.status >= 300) {
      return httpErrorFor("record-create", createResponseR.data.status, createResponseR.data.body)
    }
    if (!envelopeIsSuccessful(createResponseR.data.body)) {
      return envelopeErrorFor("record-create", createResponseR.data.status, createResponseR.data.body)
    }
    const createdParsedR = a.safeParse(recordResponseSchema, createResponseR.data.body)
    if (!createdParsedR.success) return invalidResponseErrorFor("record-create", createResponseR.data.status)
    const createdRecord = createdParsedR.output.result as CloudflareDnsRecord
    if (!mutationRecordIsExpected(createdRecord, hostname, recordType, options.address)) {
      return dnsFailureCreate(
        op,
        "record-create",
        "Cloudflare DNS create response was invalid",
        createResponseR.data.status,
      )
    }
    return createResult({ action: "created", zone, record: createdRecord })
  } catch {
    return dnsFailureCreate(op, "request", "Cloudflare DNS request failed")
  } finally {
    globalThis.clearTimeout(timeoutHandle)
    options.signal?.removeEventListener("abort", onExternalAbort)
  }
}
