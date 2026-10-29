import type { TailscaleSplitDnsOperation } from "./tailscaleSplitDnsOperationSchema.js"

/**
 * Serialize split-DNS failure details for `errorData`. Operation and HTTP
 * status only: raw API bodies and credentials must never be recorded, so
 * unlike the Cloudflare equivalent this intentionally carries no body.
 */
export function tailscaleSplitDnsErrorDataCreate(details: {
  operation: TailscaleSplitDnsOperation
  statusCode?: number
}): string {
  const data: Record<string, unknown> = { operation: details.operation }
  if (
    typeof details.statusCode === "number" &&
    Number.isInteger(details.statusCode) &&
    details.statusCode >= 100 &&
    details.statusCode <= 599
  ) {
    data["statusCode"] = details.statusCode
  }
  return JSON.stringify(data)
}
