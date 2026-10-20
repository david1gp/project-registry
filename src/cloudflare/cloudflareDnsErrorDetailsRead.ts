import * as a from "valibot"
import { cloudflareDnsOperationSchema, type CloudflareDnsOperation } from "./cloudflareDnsOperationSchema.js"

function statusCodeIsValid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
}

function cloudflareCodeIsValid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
}

export function cloudflareDnsErrorDetailsRead(error: { errorData?: string | null; statusCode?: number }): {
  operation?: CloudflareDnsOperation
  statusCode?: number
  cloudflareCode?: number
} {
  const details: { operation?: CloudflareDnsOperation; statusCode?: number; cloudflareCode?: number } = {}
  if (typeof error !== "object" || error === null) return details
  if (statusCodeIsValid(error.statusCode)) details.statusCode = error.statusCode
  if (typeof error.errorData !== "string" || error.errorData.length === 0) return details
  let parsed: unknown
  try {
    parsed = JSON.parse(error.errorData)
  } catch {
    return details
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return details
  const record = parsed as Record<string, unknown>
  const operationR = a.safeParse(cloudflareDnsOperationSchema, record["operation"])
  if (operationR.success) details.operation = operationR.output
  if (details.statusCode === undefined && statusCodeIsValid(record["statusCode"])) {
    details.statusCode = record["statusCode"]
  }
  if (cloudflareCodeIsValid(record["cloudflareCode"])) details.cloudflareCode = record["cloudflareCode"]
  return details
}
