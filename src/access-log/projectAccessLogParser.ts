import { createResult, createResultError, type Result } from "#result"
import type { ProjectAccessLogRecord } from "./ProjectAccessLogSource.js"

const maximumRecordBytes = 1024 * 1024
const maximumRecordDepth = 32
const maximumContainerEntries = 4_096
const maximumRecordNodes = 16_384

function recordError(message = "access log record is malformed"): Result<ProjectAccessLogRecord> {
  return { ...createResultError("projectAccessLogParser", message), code: "access-log.invalid-input" }
}

type PendingValue = { value: unknown; depth: number }

function valueIsPlainObject(value: object): value is Record<string, unknown> {
  const prototype = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

function recordIsBoundedJson(value: unknown): value is ProjectAccessLogRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false

  const pending: PendingValue[] = [{ value, depth: 0 }]
  const seen = new Set<object>()
  let nodeCount = 0
  let textLength = 0

  while (pending.length > 0) {
    const current = pending.pop()
    if (current === undefined) return false
    const currentValue = current.value
    nodeCount += 1
    if (nodeCount > maximumRecordNodes || current.depth > maximumRecordDepth) return false

    if (currentValue === null || typeof currentValue === "boolean") continue
    if (typeof currentValue === "number") {
      if (!Number.isFinite(currentValue)) return false
      continue
    }
    if (typeof currentValue === "string") {
      textLength += currentValue.length
      if (textLength > maximumRecordBytes) return false
      continue
    }
    if (typeof currentValue !== "object" || seen.has(currentValue)) return false
    seen.add(currentValue)

    if (Array.isArray(currentValue)) {
      if (current.depth >= maximumRecordDepth || currentValue.length > maximumContainerEntries) return false
      for (const item of currentValue) pending.push({ value: item, depth: current.depth + 1 })
      continue
    }
    if (!valueIsPlainObject(currentValue)) return false
    const keys = Object.keys(currentValue)
    if (current.depth >= maximumRecordDepth || keys.length > maximumContainerEntries) return false
    for (const key of keys) {
      textLength += key.length
      if (textLength > maximumRecordBytes) return false
      pending.push({ value: currentValue[key], depth: current.depth + 1 })
    }
  }
  return true
}

function jsonValue(input: unknown): unknown {
  if (typeof input !== "string") return input
  if (new TextEncoder().encode(input).byteLength > maximumRecordBytes) return undefined
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

export function projectAccessLogParser(input: unknown): Result<ProjectAccessLogRecord> {
  const value = jsonValue(input)
  try {
    if (!recordIsBoundedJson(value)) return recordError()
  } catch {
    return recordError()
  }
  return createResult(value)
}
