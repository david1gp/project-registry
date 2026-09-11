import * as v from "valibot"
import { createResult, createResultError, type Result } from "#result"
import { type ProjectServices, projectServicesSchema } from "./projectServicesSchema.js"

type ProjectServicesClientResult = Result<{ project: ProjectServices; revision: string }> & {
  code?: string
  statusCode?: number
  hint?: string
}
type ProjectServicesFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const projectServicesResponseSchema = v.object({ project: projectServicesSchema, revision: v.string() })

function clientError(message: string, code: string, statusCode?: number, hint?: string): ProjectServicesClientResult {
  return {
    ...createResultError("projectServicesClientGet", message),
    code,
    statusCode,
    ...(hint === undefined ? {} : { hint }),
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

export async function projectServicesClientGet(
  owner: string,
  name: string,
  options: { signal?: AbortSignal } = {},
  requestFetch: ProjectServicesFetch = fetch,
): Promise<ProjectServicesClientResult> {
  const path = `/api/v1/users/${encodeURIComponent(owner)}/projects/${encodeURIComponent(name)}`

  let response: Response
  try {
    response = await requestFetch(path, { headers: { accept: "application/json" }, signal: options.signal })
  } catch {
    if (options.signal?.aborted === true) return clientError("Die Anfrage wurde abgebrochen.", "request.aborted")
    return clientError("Die Dienste konnten nicht geladen werden.", "request.unavailable")
  }

  let body: unknown
  try {
    body = await response.json()
  } catch {
    return clientError("Der Server hat eine ungültige Antwort gesendet.", "response.malformed", response.status)
  }

  const envelope = recordValue(body)
  if (!response.ok || envelope?.success === false) {
    const error = recordValue(envelope?.error)
    const code = typeof error?.code === "string" ? error.code : "request.unavailable"
    const message = typeof error?.message === "string" ? error.message : "Die Dienste sind nicht verfügbar."
    const hint = typeof error?.hint === "string" ? error.hint : undefined
    return clientError(message, code, response.status, hint)
  }
  if (envelope?.success !== true) {
    return clientError("Der Server hat eine ungültige Antwort gesendet.", "response.malformed", response.status)
  }

  const parsed = v.safeParse(projectServicesResponseSchema, envelope.data)
  if (!parsed.success) {
    return clientError("Der Server hat ungültige Dienstdaten gesendet.", "response.malformed", response.status)
  }
  return createResult(parsed.output)
}
