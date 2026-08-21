#!/usr/bin/env bun

import { readFile } from "node:fs/promises"
import { resolve } from "node:path"
import { createResult, createResultError, type PromiseResult, type Result } from "@adaptive-ds/result"
import { caddyConfigValidate } from "../../src/caddy/caddyConfigValidate.js"
import { caddyProcessRun } from "../../src/caddy/caddyProcessRun.js"
import { caddyCandidateGenerate } from "./caddy-candidate-generate.js"

type JsonRecord = Record<string, unknown>

type ParityOptions = {
  candidate?: string
  caddyAccessCommand?: string
  caddyBin?: string
  caddyGroup?: string
  caddyUser?: string
  json: boolean
  legacy: string
  repository?: string
  validate: boolean
}

type ParityArguments = { help: true } | { help: false; options: ParityOptions }

type RouteFeatures = {
  access: unknown[]
  browse: unknown[]
  docs: unknown[]
  headers: unknown[]
  oidc: unknown[]
  proxy: unknown[]
  spa: unknown[]
  static: unknown[]
}

type RouteEntry = {
  features: RouteFeatures
  route: unknown
}

type RouteCatalog = Map<string, RouteEntry[]>

type ParityDifferenceCategory =
  | "listener"
  | "hostname"
  | "proxy upstream/port"
  | "static root/path"
  | "headers"
  | "docs/browse/SPA behavior"
  | "access rules"
  | "OIDC handlers"
  | "route behavior"

type ParityDifference = {
  category: ParityDifferenceCategory
  hostname?: string
  legacy: unknown
  migrated: unknown
  message: string
}

type ParityValidation = {
  caddyBin?: string
  error?: string
  requested: boolean
  status: "passed" | "skipped" | "failed"
}

type ParityReport = {
  differences: ParityDifference[]
  parity: boolean
  validation: ParityValidation
}

const defaultAdminListener = "127.0.0.1:2019"
const differenceCategoryOrder: readonly ParityDifferenceCategory[] = [
  "listener",
  "hostname",
  "proxy upstream/port",
  "static root/path",
  "headers",
  "docs/browse/SPA behavior",
  "access rules",
  "OIDC handlers",
  "route behavior",
]

function parityRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function parityCanonical(value: unknown): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(parityCanonical).join(",")}]`

  const record = parityRecord(value)
  if (record === undefined) return JSON.stringify(String(value))
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${parityCanonical(record[key])}`)
    .join(",")}}`
}

function parityArgumentValue(args: readonly string[], index: number, option: string): Result<string> {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--"))
    return createResultError("caddySemanticParityArgumentsParse", `${option} needs a value`)
  return createResult(value)
}

function parityArgumentsParse(args: readonly string[]): Result<ParityArguments> {
  let candidate: string | undefined
  let caddyAccessCommand: string | undefined
  let caddyBin: string | undefined
  let caddyGroup: string | undefined
  let caddyUser: string | undefined
  let json = false
  let legacy: string | undefined
  let repository: string | undefined
  let validate = false

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === undefined) continue
    if (argument === "--help" || argument === "-h") return createResult({ help: true })
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--validate" || argument === "--validate-caddy") {
      validate = true
      continue
    }

    const valueOption = [
      "--legacy",
      "--candidate",
      "--repository",
      "--caddy-access-command",
      "--caddy-bin",
      "--caddy-group",
      "--caddy-user",
    ].find((option) => argument === option)
    if (valueOption === undefined)
      return createResultError("caddySemanticParityArgumentsParse", `unknown argument: ${argument}`)
    const valueR = parityArgumentValue(args, index, valueOption)
    if (!valueR.success) return valueR
    index += 1
    if (valueOption === "--legacy") legacy = valueR.data
    if (valueOption === "--candidate") candidate = valueR.data
    if (valueOption === "--repository") repository = valueR.data
    if (valueOption === "--caddy-access-command") caddyAccessCommand = valueR.data
    if (valueOption === "--caddy-bin") {
      caddyBin = valueR.data
      validate = true
    }
    if (valueOption === "--caddy-group") {
      caddyGroup = valueR.data
      validate = true
    }
    if (valueOption === "--caddy-user") {
      caddyUser = valueR.data
      validate = true
    }
  }

  if (legacy === undefined || legacy.trim() === "") {
    return createResultError("caddySemanticParityArgumentsParse", "--legacy is required")
  }
  if (candidate !== undefined && repository !== undefined) {
    return createResultError("caddySemanticParityArgumentsParse", "--candidate and --repository are mutually exclusive")
  }
  if (candidate === undefined && repository === undefined) {
    return createResultError("caddySemanticParityArgumentsParse", "one of --candidate or --repository is required")
  }
  if (validate && (caddyBin === undefined || caddyBin.trim() === "")) {
    return createResultError("caddySemanticParityArgumentsParse", "--validate requires --caddy-bin")
  }
  if (caddyAccessCommand !== undefined && (caddyUser === undefined || caddyUser.trim() === "")) {
    return createResultError("caddySemanticParityArgumentsParse", "--caddy-access-command requires --caddy-user")
  }
  if (caddyGroup !== undefined && (caddyUser === undefined || caddyUser.trim() === "")) {
    return createResultError("caddySemanticParityArgumentsParse", "--caddy-group requires --caddy-user")
  }

  return createResult({
    help: false,
    options: {
      ...(candidate === undefined ? {} : { candidate }),
      ...(caddyAccessCommand === undefined ? {} : { caddyAccessCommand }),
      ...(caddyBin === undefined ? {} : { caddyBin }),
      ...(caddyGroup === undefined ? {} : { caddyGroup }),
      ...(caddyUser === undefined ? {} : { caddyUser }),
      json,
      legacy,
      ...(repository === undefined ? {} : { repository }),
      validate,
    },
  })
}

async function parityJsonRead(path: string): PromiseResult<JsonRecord> {
  const op = "caddySemanticParityJsonRead"
  let input: string
  try {
    input = await readFile(resolve(path), "utf8")
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : String(error), path)
  }

  try {
    const parsed: unknown = JSON.parse(input)
    const record = parityRecord(parsed)
    if (record === undefined) return createResultError(op, "Caddy configuration must be a JSON object", path)
    return createResult(record)
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : String(error), path)
  }
}

function parityHostNormalize(value: string): string {
  return value.trim().toLowerCase().replace(/\.+$/, "")
}

function parityListenerNormalize(value: string): string {
  const listener = value.trim().toLowerCase()
  const wildcard = listener.match(/^(?:0\.0\.0\.0|\[::\]):(\d+)$/)
  return wildcard?.[1] === undefined ? listener : `:${wildcard[1]}`
}

function parityAdminListenerNormalize(value: string): string {
  const listener = parityListenerNormalize(value)
  if (listener === "localhost:2019" || listener === "127.0.0.1:2019" || listener === "[::1]:2019") {
    return defaultAdminListener
  }
  return listener
}

function parityValueNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => parityValueNormalize(item))
  const record = parityRecord(value)
  if (record === undefined) return value

  const normalized: JsonRecord = {}
  for (const name of Object.keys(record).sort()) {
    const item = record[name]
    if (name === "host" && Array.isArray(item) && item.every((host) => typeof host === "string")) {
      normalized[name] = item.map((host) => parityHostNormalize(host)).sort()
      continue
    }
    normalized[name] = parityValueNormalize(item)
  }
  return normalized
}

function parityRouteNormalize(value: unknown): unknown {
  return parityValueNormalize(value)
}

function parityObjectWithout(record: JsonRecord, omitted: string): JsonRecord {
  const output: JsonRecord = {}
  for (const [key, value] of Object.entries(record)) {
    if (key !== omitted) output[key] = value
  }
  return output
}

function parityFeaturesCreate(): RouteFeatures {
  return { access: [], browse: [], docs: [], headers: [], oidc: [], proxy: [], spa: [], static: [] }
}

function parityValueContainsHandler(value: unknown, handlerName: string): boolean {
  if (Array.isArray(value)) return value.some((item) => parityValueContainsHandler(item, handlerName))
  const record = parityRecord(value)
  if (record === undefined) return false
  if (record.handler === handlerName) return true
  return Object.values(record).some((item) => parityValueContainsHandler(item, handlerName))
}

function parityAccessRuleExtract(record: JsonRecord, features: RouteFeatures): void {
  const match = record.match
  if (!Array.isArray(match)) return
  const hasRestriction = match.some((matcher) => {
    const matcherRecord = parityRecord(matcher)
    if (matcherRecord === undefined) return false
    if (Object.hasOwn(matcherRecord, "not")) return true
    const regexp = parityRecord(matcherRecord.path_regexp)
    return typeof regexp?.pattern === "string" && regexp.pattern === "^/\\..*"
  })
  const hasOidcPath = match.some((matcher) => {
    const matcherRecord = parityRecord(matcher)
    return Array.isArray(matcherRecord?.path) && parityValueContainsHandler(record, "oidc")
  })
  if (!hasRestriction && !hasOidcPath) return
  features.access.push(
    parityValueNormalize({
      ...(hasOidcPath ? { kind: "oidc-path" } : {}),
      match,
      ...(record.handle === undefined ? {} : { handle: record.handle }),
    }),
  )
}

function parityRouteFeaturesWalk(value: unknown, features: RouteFeatures, inDocs: boolean): void {
  if (Array.isArray(value)) {
    for (const item of value) parityRouteFeaturesWalk(item, features, inDocs)
    return
  }

  const record = parityRecord(value)
  if (record === undefined) return
  const currentInDocs = inDocs || record.group === "docs"

  if (record.group === "docs") features.docs.push(parityValueNormalize(record))
  parityAccessRuleExtract(record, features)

  const handler = record.handler
  if (handler === "reverse_proxy") features.proxy.push(parityValueNormalize(parityObjectWithout(record, "headers")))
  if (handler === "headers" && !currentInDocs) features.headers.push(parityValueNormalize(record))
  if (handler === "vars" && !currentInDocs && typeof record.root === "string") {
    features.static.push({ kind: "vars", root: record.root })
  }
  if (handler === "file_server" && !currentInDocs) {
    if (Object.hasOwn(record, "browse")) features.browse.push(parityValueNormalize({ browse: record.browse }))
  }
  if (handler === "rewrite" && !currentInDocs) features.spa.push(parityValueNormalize({ rewrite: record.uri }))
  if (handler === "oidc") features.oidc.push(parityValueNormalize(record))

  const file = parityRecord(record.file)
  if (file !== undefined && !currentInDocs) {
    if (typeof file.root === "string") features.static.push({ kind: "file-matcher", root: file.root })
    features.spa.push(parityValueNormalize({ file }))
  }

  for (const child of Object.values(record)) parityRouteFeaturesWalk(child, features, currentInDocs)
}

function parityRouteFeaturesNormalize(features: RouteFeatures): RouteFeatures {
  const values = Object.fromEntries(
    Object.entries(features).map(([key, items]) => [
      key,
      [...items].sort((left, right) => parityCanonical(left).localeCompare(parityCanonical(right))),
    ]) as [keyof RouteFeatures, unknown[]][],
  ) as RouteFeatures
  return values
}

function parityRouteHosts(route: JsonRecord): string[] {
  const match = route.match
  if (!Array.isArray(match)) return []
  const hosts: string[] = []
  for (const matcher of match) {
    const matcherRecord = parityRecord(matcher)
    if (!Array.isArray(matcherRecord?.host)) continue
    for (const host of matcherRecord.host) {
      if (typeof host === "string") hosts.push(parityHostNormalize(host))
    }
  }
  return [...new Set(hosts)].sort()
}

function parityHttpRoutes(config: JsonRecord): unknown[] {
  const apps = parityRecord(config.apps)
  const http = parityRecord(apps?.http)
  const servers = parityRecord(http?.servers)
  if (servers === undefined) return []
  const routes: unknown[] = []
  for (const server of Object.values(servers)) {
    const serverRecord = parityRecord(server)
    if (serverRecord === undefined || !Array.isArray(serverRecord.routes)) continue
    routes.push(...serverRecord.routes)
  }
  return routes
}

function parityRouteCatalog(config: JsonRecord): RouteCatalog {
  const catalog: RouteCatalog = new Map()
  for (const routeValue of parityHttpRoutes(config)) {
    const route = parityRecord(routeValue)
    if (route === undefined) continue
    const features = parityFeaturesCreate()
    parityRouteFeaturesWalk(route, features, false)
    const entry: RouteEntry = { features: parityRouteFeaturesNormalize(features), route: parityRouteNormalize(route) }
    const hosts = parityRouteHosts(route)
    for (const hostname of hosts.length === 0 ? ["<unhosted>"] : hosts) {
      const entries = catalog.get(hostname) ?? []
      entries.push(entry)
      catalog.set(hostname, entries)
    }
  }
  for (const [hostname, entries] of catalog) {
    entries.sort((left, right) => {
      const featureOrder = parityCanonical(left.features).localeCompare(parityCanonical(right.features))
      if (featureOrder !== 0) return featureOrder
      return parityCanonical(left.route).localeCompare(parityCanonical(right.route))
    })
    catalog.set(hostname, entries)
  }
  return catalog
}

function parityHttpListeners(config: JsonRecord): string[] {
  const apps = parityRecord(config.apps)
  const http = parityRecord(apps?.http)
  const servers = parityRecord(http?.servers)
  if (servers === undefined) return []
  const listeners: string[] = []
  for (const server of Object.values(servers)) {
    const listen = parityRecord(server)?.listen
    if (Array.isArray(listen)) {
      for (const value of listen) if (typeof value === "string") listeners.push(parityListenerNormalize(value))
    } else if (typeof listen === "string") {
      listeners.push(parityListenerNormalize(listen))
    }
  }
  return listeners.sort()
}

function parityAdmin(config: JsonRecord): unknown {
  if (!Object.hasOwn(config, "admin")) return { listen: defaultAdminListener }
  if (config.admin === false) return { disabled: true }
  const admin = parityRecord(config.admin)
  if (admin === undefined) return parityValueNormalize(config.admin)
  const normalized: JsonRecord = {}
  for (const [key, value] of Object.entries(admin)) {
    normalized[key] = key === "listen" && typeof value === "string" ? parityAdminListenerNormalize(value) : value
  }
  if (!Object.hasOwn(normalized, "listen") && normalized.disabled !== true) normalized.listen = defaultAdminListener
  return parityValueNormalize(normalized)
}

function parityOidcConfig(config: JsonRecord): unknown {
  const apps = parityRecord(config.apps)
  return parityValueNormalize(apps?.oidc)
}

function parityRedact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(parityRedact)
  const record = parityRecord(value)
  if (record === undefined) return value
  const output: JsonRecord = {}
  for (const [key, item] of Object.entries(record)) {
    if (/(?:secret|password|token|authorization|client_id|client_secret|cookie)/i.test(key)) output[key] = "[redacted]"
    else output[key] = parityRedact(item)
  }
  return output
}

function parityDifferenceCreate(
  category: ParityDifferenceCategory,
  legacy: unknown,
  migrated: unknown,
  hostname?: string,
): ParityDifference {
  const subject = hostname === undefined ? "configuration" : `hostname ${hostname}`
  return {
    category,
    ...(hostname === undefined ? {} : { hostname }),
    legacy: parityRedact(legacy),
    migrated: parityRedact(migrated),
    message: `${category} differs for ${subject}`,
  }
}

function parityDifferenceSort(left: ParityDifference, right: ParityDifference): number {
  const leftCategory = differenceCategoryOrder.indexOf(left.category)
  const rightCategory = differenceCategoryOrder.indexOf(right.category)
  if (leftCategory !== rightCategory) return leftCategory - rightCategory
  const hostnameOrder = (left.hostname ?? "").localeCompare(right.hostname ?? "")
  if (hostnameOrder !== 0) return hostnameOrder
  return parityCanonical({ legacy: left.legacy, migrated: left.migrated }).localeCompare(
    parityCanonical({ legacy: right.legacy, migrated: right.migrated }),
  )
}

function parityRouteDifferenceCompare(legacy: RouteEntry, migrated: RouteEntry, hostname: string): ParityDifference[] {
  const differences: ParityDifference[] = []
  const featureComparisons: {
    category: ParityDifferenceCategory
    key: keyof RouteFeatures
  }[] = [
    { category: "proxy upstream/port", key: "proxy" },
    { category: "static root/path", key: "static" },
    { category: "headers", key: "headers" },
    { category: "access rules", key: "access" },
    { category: "OIDC handlers", key: "oidc" },
  ]
  for (const comparison of featureComparisons) {
    const legacyValue = legacy.features[comparison.key]
    const migratedValue = migrated.features[comparison.key]
    if (parityCanonical(legacyValue) !== parityCanonical(migratedValue)) {
      differences.push(parityDifferenceCreate(comparison.category, legacyValue, migratedValue, hostname))
    }
  }

  const legacyDocsBrowseSpa = {
    browse: legacy.features.browse,
    docs: legacy.features.docs,
    spa: legacy.features.spa,
  }
  const migratedDocsBrowseSpa = {
    browse: migrated.features.browse,
    docs: migrated.features.docs,
    spa: migrated.features.spa,
  }
  if (parityCanonical(legacyDocsBrowseSpa) !== parityCanonical(migratedDocsBrowseSpa)) {
    differences.push(
      parityDifferenceCreate("docs/browse/SPA behavior", legacyDocsBrowseSpa, migratedDocsBrowseSpa, hostname),
    )
  }

  if (differences.length === 0 && parityCanonical(legacy.route) !== parityCanonical(migrated.route)) {
    differences.push(parityDifferenceCreate("route behavior", legacy.route, migrated.route, hostname))
  }
  return differences
}

function parityCompare(legacy: JsonRecord, migrated: JsonRecord): ParityDifference[] {
  const differences: ParityDifference[] = []
  const legacyListeners = { admin: parityAdmin(legacy), https: parityHttpListeners(legacy) }
  const migratedListeners = { admin: parityAdmin(migrated), https: parityHttpListeners(migrated) }
  if (parityCanonical(legacyListeners) !== parityCanonical(migratedListeners)) {
    differences.push(parityDifferenceCreate("listener", legacyListeners, migratedListeners))
  }

  const legacyRoutes = parityRouteCatalog(legacy)
  const migratedRoutes = parityRouteCatalog(migrated)
  const hostnames = [...new Set([...legacyRoutes.keys(), ...migratedRoutes.keys()])].sort()
  for (const hostname of hostnames) {
    const legacyEntries = legacyRoutes.get(hostname)
    const migratedEntries = migratedRoutes.get(hostname)
    if (legacyEntries === undefined || migratedEntries === undefined) {
      differences.push(
        parityDifferenceCreate(
          "hostname",
          legacyEntries === undefined ? "absent" : "present",
          migratedEntries === undefined ? "absent" : "present",
          hostname,
        ),
      )
      continue
    }
    if (legacyEntries.length !== migratedEntries.length) {
      differences.push(parityDifferenceCreate("route behavior", legacyEntries.length, migratedEntries.length, hostname))
      continue
    }
    for (let index = 0; index < legacyEntries.length; index += 1) {
      const legacyEntry = legacyEntries[index]
      const migratedEntry = migratedEntries[index]
      if (legacyEntry === undefined || migratedEntry === undefined) continue
      differences.push(...parityRouteDifferenceCompare(legacyEntry, migratedEntry, hostname))
    }
  }

  const legacyOidc = parityOidcConfig(legacy)
  const migratedOidc = parityOidcConfig(migrated)
  if (parityCanonical(legacyOidc) !== parityCanonical(migratedOidc)) {
    differences.push(parityDifferenceCreate("OIDC handlers", legacyOidc, migratedOidc))
  }
  return differences.sort(parityDifferenceSort)
}

function parityDisplay(value: unknown): string {
  return parityCanonical(value)
}

function parityUsage(): string {
  return `Usage:
  bun run ops/migration/caddy-semantic-parity.ts --legacy PATH (--candidate PATH | --repository PATH) [options]

Options:
  --legacy PATH       Legacy generated Caddy JSON
  --candidate PATH    Migrated generated Caddy JSON to compare
  --repository PATH   Migrated Project Registry Git worktree; generate its candidate offline
  --caddy-bin PATH    Production Caddy binary; validate the candidate with stdin and caddy validate
  --caddy-user USER   Run native validation as this Caddy-compatible user
  --caddy-group GROUP Run native validation with this exact primary group
  --caddy-access-command PATH  User-switch command (default /usr/sbin/runuser when --caddy-user is set)
  --validate          Require --caddy-bin and validate the candidate (same as --caddy-bin)
  --json              Emit a deterministic machine-readable report
  --help              Show this help

The command never calls the Caddy admin API and never loads the candidate. The legacy file should
be produced by the existing legacy generator, and the migrated file is produced by task 3 when
--repository is used. The explicit legacy 127.0.0.1:2019 admin listener is equivalent to Caddy's
default admin listener and is not reported as a difference.`
}

async function parityRun(options: ParityOptions): PromiseResult<ParityReport> {
  const legacyR = await parityJsonRead(options.legacy)
  if (!legacyR.success) return legacyR

  let migrated: JsonRecord
  if (options.candidate !== undefined) {
    const candidateR = await parityJsonRead(options.candidate)
    if (!candidateR.success) return candidateR
    migrated = candidateR.data
  } else {
    const repository = options.repository
    if (repository === undefined) return createResultError("caddySemanticParityRun", "migrated repository is missing")
    const candidateR = await caddyCandidateGenerate(repository, Bun.env)
    if (!candidateR.success) return candidateR
    try {
      const parsed: unknown = JSON.parse(candidateR.data)
      const record = parityRecord(parsed)
      if (record === undefined)
        return createResultError("caddySemanticParityRun", "generated candidate is not a JSON object")
      migrated = record
    } catch (error) {
      return createResultError("caddySemanticParityRun", error instanceof Error ? error.message : String(error))
    }
  }

  let validation: ParityValidation = { requested: false, status: "skipped" }
  if (options.validate && options.caddyBin !== undefined) {
    const processRunner =
      options.caddyUser === undefined
        ? undefined
        : (command: string, args: readonly string[], input: string, processOptions?: Parameters<typeof caddyProcessRun>[3]) =>
            caddyProcessRun(
              options.caddyAccessCommand ?? "/usr/sbin/runuser",
              [
                "-u",
                options.caddyUser!,
                ...(options.caddyGroup === undefined ? [] : ["-g", options.caddyGroup]),
                "--",
                command,
                ...args,
              ],
              input,
              processOptions,
            )
    const validationR = await caddyConfigValidate(migrated, {
      caddyBin: options.caddyBin,
      ...(processRunner === undefined ? {} : { processRunner }),
    })
    validation = validationR.success
      ? { caddyBin: options.caddyBin, requested: true, status: "passed" }
      : { caddyBin: options.caddyBin, error: validationR.errorMessage, requested: true, status: "failed" }
  }

  const differences = parityCompare(legacyR.data, migrated)
  return createResult({ differences, parity: differences.length === 0 && validation.status !== "failed", validation })
}

function parityReportWrite(report: ParityReport, json: boolean): void {
  if (json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  console.log(`semantic parity: ${report.parity ? "PASS" : "FAIL"}`)
  if (report.validation.status === "skipped") console.log("candidate validation: skipped")
  if (report.validation.status === "passed") console.log(`candidate validation: passed (${report.validation.caddyBin})`)
  if (report.validation.status === "failed") {
    console.log(`candidate validation: failed (${report.validation.caddyBin}): ${report.validation.error}`)
  }
  for (const difference of report.differences) {
    const subject = difference.hostname === undefined ? "" : ` [${difference.hostname}]`
    console.log(
      `- ${difference.category}${subject}: ${difference.message}; legacy=${parityDisplay(difference.legacy)}; migrated=${parityDisplay(
        difference.migrated,
      )}`,
    )
  }
}

if (import.meta.main) {
  const argumentsR = parityArgumentsParse(process.argv.slice(2))
  if (!argumentsR.success) {
    console.error(`semantic parity failed: ${argumentsR.errorMessage}`)
    process.exitCode = 1
  } else if (argumentsR.data.help) {
    console.log(parityUsage())
  } else {
    const reportR = await parityRun(argumentsR.data.options)
    if (!reportR.success) {
      console.error(`semantic parity failed: ${reportR.errorMessage}`)
      process.exitCode = 1
    } else {
      parityReportWrite(reportR.data, argumentsR.data.options.json)
      if (!reportR.data.parity) process.exitCode = 1
    }
  }
}
