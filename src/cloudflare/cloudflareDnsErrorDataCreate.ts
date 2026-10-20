import type { CloudflareDnsOperation } from "./cloudflareDnsOperationSchema.js"

export function cloudflareDnsErrorDataCreate(details: {
  operation: CloudflareDnsOperation
  statusCode?: number
  body?: unknown
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
  const cloudflareCode = cloudflareCodeExtract(details.body)
  if (cloudflareCode !== undefined) data["cloudflareCode"] = cloudflareCode
  return JSON.stringify(data)
}

function cloudflareCodeExtract(body: unknown): number | undefined {
  if (typeof body !== "object" || body === null) return undefined
  const errors = (body as { errors?: unknown }).errors
  if (!Array.isArray(errors)) return undefined
  for (const entry of errors) {
    if (typeof entry !== "object" || entry === null) continue
    const code = (entry as { code?: unknown }).code
    if (typeof code === "number" && Number.isSafeInteger(code) && code > 0) return code
  }
  return undefined
}
