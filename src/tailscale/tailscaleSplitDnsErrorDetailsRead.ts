import * as a from "valibot"
import {
  type TailscaleSplitDnsOperation,
  tailscaleSplitDnsOperationSchema,
} from "./tailscaleSplitDnsOperationSchema.js"

function statusCodeIsValid(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599
}

export function tailscaleSplitDnsErrorDetailsRead(error: { errorData?: string | null; statusCode?: number }): {
  operation?: TailscaleSplitDnsOperation
  statusCode?: number
} {
  const details: { operation?: TailscaleSplitDnsOperation; statusCode?: number } = {}
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
  const operationR = a.safeParse(tailscaleSplitDnsOperationSchema, record["operation"])
  if (operationR.success) details.operation = operationR.output
  if (details.statusCode === undefined && statusCodeIsValid(record["statusCode"])) {
    details.statusCode = record["statusCode"]
  }
  return details
}
