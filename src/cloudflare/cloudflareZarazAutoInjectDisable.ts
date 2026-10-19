import * as a from "valibot"
import { createResult, createResultError, type PromiseResult } from "#result"
import type { CloudflareZarazAutoInjectDisableOptions } from "./CloudflareZarazAutoInjectDisableOptions.js"
import type { CloudflareZarazAutoInjectDisableResult } from "./CloudflareZarazAutoInjectDisableResult.js"

const apiEnvelopeSchema = a.object({ success: a.boolean(), result: a.unknown() })
const configShapeSchema = a.object({
  success: a.literal(true),
  result: a.object({ settings: a.object({ autoInjectScript: a.boolean() }) }),
})
const workflowSchema = a.object({
  success: a.literal(true),
  result: a.union([a.literal("realtime"), a.literal("preview")]),
})

function envelopeIsSuccessful(body: unknown): boolean {
  const envelopeR = a.safeParse(apiEnvelopeSchema, body)
  return envelopeR.success && envelopeR.output.success
}

function recordIsObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function variablesAreComplete(variables: unknown): boolean {
  if (variables === undefined) return true
  if (!recordIsObject(variables)) return false
  const entries = Object.values(variables)
  if (entries.length === 0) return true
  return entries.every((variable) => {
    if (!recordIsObject(variable)) return false
    return variable["value"] !== undefined && variable["value"] !== null
  })
}

function variablesArePresent(variables: unknown): boolean {
  return recordIsObject(variables) && Object.keys(variables).length > 0
}

function canonicalValueCreate(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalValueCreate).join(",")}]`
  }
  if (recordIsObject(value)) {
    const entries = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalValueCreate(value[key])}`)
    return `{${entries.join(",")}}`
  }
  return JSON.stringify(value) ?? "undefined"
}

function configurationsMatch(current: unknown, exported: unknown, secretVariable = false): boolean {
  if (Array.isArray(current) || Array.isArray(exported)) {
    if (!Array.isArray(current) || !Array.isArray(exported) || current.length !== exported.length) return false
    const currentCanonical = current.map(canonicalValueCreate)
    const exportedCanonical = exported.map(canonicalValueCreate)
    return currentCanonical.every((value, index) => value === exportedCanonical[index])
  }
  if (!recordIsObject(current) || !recordIsObject(exported)) return Object.is(current, exported)

  const currentKeys = Object.keys(current).sort()
  const exportedKeys = Object.keys(exported).sort()
  const extraExportedKeys = exportedKeys.filter((key) => !currentKeys.includes(key))
  const isSecretValueEnrichment =
    secretVariable &&
    extraExportedKeys.length === 1 &&
    extraExportedKeys[0] === "value" &&
    exported["value"] !== undefined &&
    exported["value"] !== null
  if (extraExportedKeys.length > 0 && !isSecretValueEnrichment) return false
  if (currentKeys.some((key) => !exportedKeys.includes(key))) return false
  return currentKeys.every((key) => {
    if (key === "variables" && recordIsObject(current[key]) && recordIsObject(exported[key])) {
      const currentVariables = current[key]
      const exportedVariables = exported[key]
      const currentNames = Object.keys(currentVariables).sort()
      const exportedNames = Object.keys(exportedVariables).sort()
      if (currentNames.length !== exportedNames.length || currentNames.some((name, index) => name !== exportedNames[index])) {
        return false
      }
      return currentNames.every((name) => {
        const variable = currentVariables[name]
        return configurationsMatch(variable, exportedVariables[name], recordIsObject(variable) && variable["type"] === "secret")
      })
    }
    return configurationsMatch(current[key], exported[key])
  })
}

function configurationBodyCreate(source: Record<string, unknown>): Record<string, unknown> {
  const settings = source["settings"]
  const settingsRecord = recordIsObject(settings) ? settings : {}
  return { ...source, settings: { ...settingsRecord, autoInjectScript: false } }
}

export async function cloudflareZarazAutoInjectDisable(
  options: CloudflareZarazAutoInjectDisableOptions,
): PromiseResult<CloudflareZarazAutoInjectDisableResult> {
  const op = "cloudflareZarazAutoInjectDisable"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Cloudflare Zaraz options are required")
  if (typeof options.zoneId !== "string" || options.zoneId.length === 0) {
    return createResultError(op, "Cloudflare Zaraz zone id is invalid")
  }
  if (typeof options.request !== "function") return createResultError(op, "Cloudflare Zaraz request is invalid")
  const zonePath = `/zones/${encodeURIComponent(options.zoneId)}`

  const workflowR = await options.request(`${zonePath}/settings/zaraz/workflow`, { method: "GET" })
  if (!workflowR.success) return workflowR
  if (workflowR.data.status < 200 || workflowR.data.status >= 300 || !envelopeIsSuccessful(workflowR.data.body)) {
    return createResultError(op, `Cloudflare Zaraz request failed (status ${workflowR.data.status})`)
  }
  const workflowParsedR = a.safeParse(workflowSchema, workflowR.data.body)
  if (!workflowParsedR.success) return createResultError(op, "Cloudflare Zaraz workflow response was invalid")
  if (workflowParsedR.output.result !== "realtime") {
    return createResultError(op, "Cloudflare Zaraz workflow is preview; refusing to change the active configuration")
  }

  const configR = await options.request(`${zonePath}/settings/zaraz/config`, { method: "GET" })
  if (!configR.success) return configR
  if (configR.data.status < 200 || configR.data.status >= 300 || !envelopeIsSuccessful(configR.data.body)) {
    return createResultError(op, `Cloudflare Zaraz request failed (status ${configR.data.status})`)
  }
  const configParsedR = a.safeParse(configShapeSchema, configR.data.body)
  if (!configParsedR.success) return createResultError(op, "Cloudflare Zaraz configuration was invalid")
  if (!recordIsObject((configR.data.body as { result: unknown }).result)) {
    return createResultError(op, "Cloudflare Zaraz configuration was invalid")
  }
  const config = (configR.data.body as { result: Record<string, unknown> }).result
  if (configParsedR.output.result.settings.autoInjectScript === false) {
    return createResult({ action: "already-disabled" })
  }

  let source: Record<string, unknown> = config
  if (variablesArePresent(config["variables"])) {
    const exportR = await options.request(`${zonePath}/settings/zaraz/export`, { method: "GET" })
    if (!exportR.success) return exportR
    if (exportR.data.status < 200 || exportR.data.status >= 300 || !envelopeIsSuccessful(exportR.data.body)) {
      return createResultError(op, `Cloudflare Zaraz request failed (status ${exportR.data.status})`)
    }
    const exportParsedR = a.safeParse(configShapeSchema, exportR.data.body)
    if (!exportParsedR.success || !recordIsObject((exportR.data.body as { result: unknown }).result)) {
      return createResultError(op, "Cloudflare Zaraz configuration was invalid")
    }
    source = (exportR.data.body as { result: Record<string, unknown> }).result
    if (!configurationsMatch(config, source)) {
      return createResultError(op, "Cloudflare Zaraz export does not match the current configuration")
    }
    if (!variablesAreComplete(source["variables"])) {
      return createResultError(op, "Cloudflare Zaraz configuration has incomplete secret variables")
    }
  }

  const updateBody = configurationBodyCreate(source)
  const putR = await options.request(`${zonePath}/settings/zaraz/config`, {
    method: "PUT",
    body: JSON.stringify(updateBody),
  })
  if (!putR.success) return putR
  if (putR.data.status < 200 || putR.data.status >= 300 || !envelopeIsSuccessful(putR.data.body)) {
    return createResultError(op, `Cloudflare Zaraz request failed (status ${putR.data.status})`)
  }

  const readbackR = await options.request(`${zonePath}/settings/zaraz/config`, { method: "GET" })
  if (!readbackR.success) return readbackR
  if (readbackR.data.status < 200 || readbackR.data.status >= 300 || !envelopeIsSuccessful(readbackR.data.body)) {
    return createResultError(op, `Cloudflare Zaraz request failed (status ${readbackR.data.status})`)
  }
  const readbackParsedR = a.safeParse(configShapeSchema, readbackR.data.body)
  if (!readbackParsedR.success || readbackParsedR.output.result.settings.autoInjectScript !== false) {
    return createResultError(op, "Cloudflare Zaraz read-back verification failed")
  }
  return createResult({ action: "disabled" })
}
