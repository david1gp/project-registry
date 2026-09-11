import * as v from "valibot"
import { createResult, createResultError, type Result } from "#result"
import type { ProjectServicesService } from "./projectServicesSchema.js"

type ProjectServicesPatchResult = Result<{ revision: string; changed: boolean }> & {
  code?: string
  statusCode?: number
  hint?: string
}
type ProjectServicesFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>

const projectServicesMutationSchema = v.looseObject({ revision: v.string(), changed: v.boolean() })

function clientError(message: string, code: string, statusCode?: number, hint?: string): ProjectServicesPatchResult {
  return {
    ...createResultError("projectServicesClientPatch", message),
    code,
    statusCode,
    ...(hint === undefined ? {} : { hint }),
  }
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

/** Replace the full canonical service collection of one project, preserving sibling services. */
export async function projectServicesClientPatch(
  owner: string,
  name: string,
  input: { services: readonly ProjectServicesService[]; expectedRevision: string; signal?: AbortSignal },
  requestFetch: ProjectServicesFetch = fetch,
): Promise<ProjectServicesPatchResult> {
  const path = `/api/v1/users/${encodeURIComponent(owner)}/projects/${encodeURIComponent(name)}`

  let response: Response
  try {
    response = await requestFetch(path, {
      method: "PATCH",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({
        expectedRevision: input.expectedRevision,
        schemaVersion: 2,
        services: input.services,
      }),
      signal: input.signal,
    })
  } catch {
    if (input.signal?.aborted === true) return clientError("Die Anfrage wurde abgebrochen.", "request.aborted")
    return clientError("Die Dienste konnten nicht gespeichert werden.", "request.unavailable")
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
    const message = typeof error?.message === "string" ? error.message : "Die Dienste konnten nicht gespeichert werden."
    const hint = typeof error?.hint === "string" ? error.hint : undefined
    return clientError(message, code, response.status, hint)
  }

  const parsed = v.safeParse(projectServicesMutationSchema, envelope?.data)
  if (!parsed.success) {
    return clientError("Der Server hat eine ungültige Antwort gesendet.", "response.malformed", response.status)
  }
  return createResult({ revision: parsed.output.revision, changed: parsed.output.changed })
}
