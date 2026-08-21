import { createResult, type Result } from "#result"
import type { ProjectRegistryCliFetch } from "./ProjectRegistryCliFetch.js"

type ProjectRegistryCliRequestOptions = {
  method?: "GET" | "POST" | "PATCH" | "DELETE"
  body?: unknown
}

function recordValue(input: unknown): Record<string, unknown> | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return undefined
  return input as Record<string, unknown>
}

function errorResult(
  op: string,
  errorMessage: string,
  code: string,
  statusCode?: number,
): Extract<Result<never>, { success: false }> {
  return { success: false, op, errorMessage, code, statusCode }
}

export async function projectRegistryCliRequest(
  socketPath: string,
  path: string,
  optionsOrFetch: ProjectRegistryCliRequestOptions | ProjectRegistryCliFetch = {},
  requestFetch: ProjectRegistryCliFetch = fetch,
): Promise<Result<unknown>> {
  const op = "projectRegistryCliRequest"
  const options = typeof optionsOrFetch === "function" ? {} : optionsOrFetch
  const fetchRequest = typeof optionsOrFetch === "function" ? optionsOrFetch : requestFetch
  let response: Response
  try {
    response = await fetchRequest(`http://localhost${path}`, {
      method: options.method ?? "GET",
      headers:
        options.body === undefined
          ? { accept: "application/json" }
          : { accept: "application/json", "content-type": "application/json" },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      unix: socketPath,
    })
  } catch {
    return errorResult(op, `Could not communicate with project-registryd over ${socketPath}.`, "cli.transport")
  }

  let text: string
  try {
    text = await response.text()
  } catch {
    return errorResult(op, "Could not read the project-registryd response.", "cli.protocol", response.status)
  }

  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    if (!response.ok) {
      return errorResult(
        op,
        `project-registryd returned HTTP ${response.status} ${response.statusText || "Error"}.`,
        "cli.server",
        response.status,
      )
    }
    return errorResult(op, "project-registryd returned malformed JSON.", "cli.protocol", response.status)
  }

  const envelope = recordValue(body)
  if (envelope?.success === false) {
    const versionedError = recordValue(envelope.error)
    const errorMessage =
      typeof versionedError?.message === "string"
        ? versionedError.message
        : typeof envelope.errorMessage === "string"
          ? envelope.errorMessage
          : `project-registryd returned HTTP ${response.status}.`
    const code =
      typeof versionedError?.code === "string"
        ? versionedError.code
        : typeof envelope.code === "string"
          ? envelope.code
          : "cli.server"
    const resultOp =
      typeof versionedError?.op === "string" ? versionedError.op : typeof envelope.op === "string" ? envelope.op : op
    const statusCode =
      typeof versionedError?.status === "number" && Number.isInteger(versionedError.status)
        ? versionedError.status
        : response.status
    return errorResult(resultOp, errorMessage, code, statusCode)
  }
  if (envelope?.success !== true || !Object.hasOwn(envelope, "data")) {
    if (!response.ok) {
      return errorResult(
        op,
        `project-registryd returned HTTP ${response.status} ${response.statusText || "Error"}.`,
        "cli.server",
        response.status,
      )
    }
    return errorResult(op, "project-registryd returned a malformed response envelope.", "cli.protocol", response.status)
  }
  if (!response.ok) {
    return errorResult(
      op,
      "project-registryd returned success with an error HTTP status.",
      "cli.protocol",
      response.status,
    )
  }
  return createResult(envelope.data)
}
