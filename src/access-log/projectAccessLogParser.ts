import { createResult, createResultError, type Result } from "#result"
import type { ProjectAccessLogRecord } from "./ProjectAccessLogSource.js"

function recordError(message = "access log record is malformed"): Result<ProjectAccessLogRecord> {
  return { ...createResultError("projectAccessLogParser", message), code: "access-log.invalid-input" }
}

function valueIsRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function textValue(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > maximumLength) return undefined
  if ([...value].some((character) => character.charCodeAt(0) < 0x20 || character === "\u007f")) return undefined
  return value
}

function ipv4Network(value: string): string | undefined {
  const parts = value.split(".")
  if (parts.length !== 4) return undefined
  const numbers = parts.map((part) => Number(part))
  if (
    numbers.some((part, index) => !Number.isInteger(part) || part < 0 || part > 255 || parts[index] !== String(part))
  ) {
    return undefined
  }
  return `${numbers.slice(0, 3).join(".")}.0/24`
}

function ipv6Words(value: string): number[] | undefined {
  const normalized = value.toLowerCase()
  if (normalized.includes("%") || normalized.split("::").length > 2) return undefined
  const [left = "", right] = normalized.split("::")
  const parsePart = (part: string): number[] | undefined => {
    if (part === "") return []
    const values = part.split(":")
    const words: number[] = []
    for (const item of values) {
      if (item.includes(".")) {
        const network = ipv4Network(item)
        if (network === undefined) return undefined
        const address = network.slice(0, -3).split(".").map(Number)
        const [first, second, third, fourth] = address
        if (first === undefined || second === undefined || third === undefined || fourth === undefined) return undefined
        words.push((first << 8) | second, (third << 8) | fourth)
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(item)) return undefined
      words.push(Number.parseInt(item, 16))
    }
    return words
  }

  const leftWords = parsePart(left)
  const rightWords = parsePart(right ?? "")
  if (leftWords === undefined || rightWords === undefined) return undefined
  if (right === undefined) {
    return leftWords.length === 8 ? leftWords : undefined
  }
  if (leftWords.length + rightWords.length >= 8) return undefined
  return [...leftWords, ...new Array(8 - leftWords.length - rightWords.length).fill(0), ...rightWords]
}

function ipv6Format(words: readonly number[]): string {
  let bestStart = -1
  let bestLength = 0
  for (let index = 0; index < words.length; index += 1) {
    if (words[index] !== 0) continue
    let end = index
    while (end < words.length && words[end] === 0) end += 1
    if (end - index > bestLength) {
      bestStart = index
      bestLength = end - index
    }
    index = end - 1
  }
  if (bestLength < 2) return words.map((word) => word.toString(16)).join(":")
  const left = words
    .slice(0, bestStart)
    .map((word) => word.toString(16))
    .join(":")
  const right = words
    .slice(bestStart + bestLength)
    .map((word) => word.toString(16))
    .join(":")
  if (left === "" && right === "") return "::"
  if (left === "") return `::${right}`
  if (right === "") return `${left}::`
  return `${left}::${right}`
}

function clientNetwork(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const ipv4 = ipv4Network(value)
  if (ipv4 !== undefined) return ipv4
  const words = ipv6Words(value)
  if (words === undefined) return undefined
  return `${ipv6Format([...words.slice(0, 4), 0, 0, 0, 0])}/64`
}

function uriPath(value: unknown): string | undefined {
  const uri = textValue(value, 8192)
  if (uri === undefined) return undefined
  const [path = ""] = uri.split(/[?#]/, 1)
  return path === "" ? "/" : path
}

function jsonValue(input: unknown): unknown {
  if (typeof input !== "string") return input
  try {
    return JSON.parse(input) as unknown
  } catch {
    return undefined
  }
}

export function projectAccessLogParser(input: unknown): Result<ProjectAccessLogRecord> {
  const value = jsonValue(input)
  if (!valueIsRecord(value) || !valueIsRecord(value.request)) return recordError()
  const request = value.request
  const timestamp = value.ts
  const method = textValue(request.method, 32)
  const host = textValue(request.host, 2048)
  const path = uriPath(request.uri)
  const status = value.status
  const duration = value.duration
  const responseBytes = value.size
  const network = clientNetwork(request.client_ip ?? request.remote_ip)

  if (
    typeof timestamp !== "number" ||
    !Number.isFinite(timestamp) ||
    timestamp < 0 ||
    method === undefined ||
    host === undefined ||
    path === undefined ||
    typeof status !== "number" ||
    !Number.isSafeInteger(status) ||
    status < 0 ||
    status > 999 ||
    typeof duration !== "number" ||
    !Number.isFinite(duration) ||
    duration < 0 ||
    typeof responseBytes !== "number" ||
    !Number.isSafeInteger(responseBytes) ||
    responseBytes < 0 ||
    network === undefined
  ) {
    return recordError()
  }

  return createResult({ timestamp, method, host, path, status, duration, responseBytes, clientNetwork: network })
}
