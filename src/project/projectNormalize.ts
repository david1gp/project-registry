import * as a from "valibot"
import { createResult, createResultErrorCode, type Result } from "#result"
import { projectDomainNormalize } from "./projectDomainNormalize.js"
import { type ProjectInput, projectInputSchema } from "./projectInputSchema.js"
import type { ProjectKey } from "./projectKey.js"
import { type ProjectPortRange, projectPortNext } from "./projectPortNext.js"
import type { Project } from "./projectSchema.js"
import { projectValidate } from "./projectValidate.js"

export type ProjectNormalizeOptions = {
  projects?: readonly Project[]
  portRange?: ProjectPortRange
  excludeKey?: ProjectKey
  excludeProject?: Project
}

function recordValue(input: unknown): Record<string, unknown> | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

function stringValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  const text = String(value).trim()
  return text === "" ? undefined : text
}

function serviceValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const service = value.trim()
  return /^[A-Za-z0-9_.@:-]+(?:\.service)?$/.test(service) ? service : undefined
}

function numberValue(value: unknown): number | unknown {
  if (typeof value === "number") return value
  if (typeof value !== "string" || value.trim() === "") return value
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : value
}

function orderValue(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value === "string") {
    const parsed = Number.parseInt(value.trim(), 10)
    if (Number.isFinite(parsed)) return parsed
  }
  return Number.MAX_SAFE_INTEGER
}

function typeValue(value: unknown): "own" | "internal" | "customer" {
  const text = typeof value === "string" ? value.trim().toLowerCase() : ""
  if (text === "own" || text === "internal" || text === "customer") return text
  return "customer"
}

function serviceValues(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.map(serviceValue).filter((service): service is string => service !== undefined))]
}

function domainValue(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const domain = projectDomainNormalize(value)
  return domain === "" ? undefined : domain
}

function stringListValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const values = [...new Set(value.map(stringValue).filter((item): item is string => item !== undefined))]
  return values.length > 0 ? values : undefined
}

function oidcPathsValue(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  return value.filter((item): item is string => typeof item === "string" && item.length > 0)
}

function optionalText(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = stringValue(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

function caddyNormalize(value: unknown): unknown {
  if (value === null || value === undefined) return value
  const record = recordValue(value)
  if (!record) return value

  const caddy: Record<string, unknown> = {
    domains: Array.isArray(record.domains)
      ? [...new Set(record.domains.map(domainValue).filter((domain): domain is string => domain !== undefined))]
      : record.domains,
  }

  if (record.port !== undefined) caddy.port = numberValue(record.port)

  const path = stringValue(record.path)
  if (path !== undefined) caddy.path = path

  for (const key of ["access", "kind", "docs", "browse", "disabled", "denyDotfiles", "spa"] as const) {
    if (record[key] !== undefined) caddy[key] = record[key]
  }

  if (record.flushInterval !== undefined) caddy.flushInterval = numberValue(record.flushInterval)

  const headerUp = recordValue(record.headerUp)
  if (headerUp) {
    caddy.headerUp = Object.fromEntries(
      Object.entries(headerUp)
        .map(([key, headerValue]) => [key, stringValue(headerValue)])
        .filter((entry): entry is [string, string] => entry[1] !== undefined),
    )
  } else if (record.headerUp !== undefined) {
    caddy.headerUp = record.headerUp
  }

  for (const key of ["routed", "docsPath", "browseTemplate"] as const) {
    const text = stringValue(record[key])
    if (text !== undefined) caddy[key] = text
  }

  const oidcPaths = oidcPathsValue(record.oidcPaths)
  if (oidcPaths !== undefined) caddy.oidcPaths = oidcPaths

  const staticAllow = stringListValue(record.staticAllow)
  if (staticAllow !== undefined) caddy.staticAllow = staticAllow

  return caddy
}

function projectInputNormalize(input: unknown): unknown {
  const record = recordValue(input)
  if (!record) return input

  const normalized: Record<string, unknown> = {
    schemaVersion: numberValue(record.schemaVersion ?? 1),
    owner: stringValue(record.owner),
    name: stringValue(record.name),
    type: typeValue(record.type),
    order: orderValue(record.order),
    services: serviceValues(record.services),
    labels: record.labels,
  }

  const description = stringValue(record.description)
  if (description !== undefined) normalized.description = description

  const github = optionalText(record, "github")
  const previewUrl = optionalText(record, "previewUrl", "preview_url")
  const previewPort = optionalText(record, "previewPort", "preview_port")
  const productionUrl = optionalText(record, "productionUrl", "production_url")
  const productionAssetsUrl = optionalText(record, "productionAssetsUrl", "production_assets_url")
  if (github !== undefined) normalized.github = github
  if (previewUrl !== undefined) normalized.previewUrl = previewUrl
  if (previewPort !== undefined) normalized.previewPort = previewPort
  if (productionUrl !== undefined) normalized.productionUrl = productionUrl
  if (productionAssetsUrl !== undefined) normalized.productionAssetsUrl = productionAssetsUrl

  if ("caddy" in record) normalized.caddy = caddyNormalize(record.caddy)
  return normalized
}

export function projectNormalize(input: unknown, options: ProjectNormalizeOptions = {}): Result<Project> {
  const op = "projectNormalize"
  const parsed = a.safeParse(projectInputSchema, projectInputNormalize(input))
  if (!parsed.success) return createResultErrorCode(op, a.summarize(parsed.issues), "request.invalid")

  let normalized: ProjectInput = parsed.output
  if (normalized.caddy && normalized.caddy.port === undefined) {
    const excludeKey = options.excludeProject ?? options.excludeKey
    const portResult = projectPortNext(options.projects ?? [], options.portRange, excludeKey)
    if (!portResult.success) return portResult
    normalized = { ...normalized, caddy: { ...normalized.caddy, port: portResult.data } }
  }

  const projectResult = projectValidate(normalized, options)
  if (!projectResult.success) return { ...projectResult, op }
  return createResult(projectResult.data)
}
