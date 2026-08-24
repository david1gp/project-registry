import { createResult, type Result } from "#result"
import type { ProjectRegistryCliFetch } from "./ProjectRegistryCliFetch.js"

type ProjectRegistryCliError = Extract<Result<never>, { success: false }> & { hint?: string }

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
  hint?: string,
): Extract<Result<never>, { success: false }> {
  return { success: false, op, errorMessage, code, statusCode, ...(hint === undefined ? {} : { hint }) }
}

export async function projectRegistryCliRequest(
  socketPath: string,
  path: string,
  optionsOrFetch: ProjectRegistryCliRequestOptions | ProjectRegistryCliFetch = {},
  requestFetch: ProjectRegistryCliFetch = fetch,
): Promise<Result<unknown> | ProjectRegistryCliError> {
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
    return errorResult(
      op,
      `Could not communicate with project-registryd over ${socketPath}.`,
      "cli.transport",
      undefined,
      "Check that project-registryd is running and that this socket path is correct, then retry.",
    )
  }

  let text: string
  try {
    text = await response.text()
  } catch {
    return errorResult(
      op,
      "Could not read the project-registryd response.",
      "cli.protocol",
      response.status,
      "Check project-registryd logs, then retry.",
    )
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
        "Check the daemon logs for the failed request, then retry.",
      )
    }
    return errorResult(
      op,
      "project-registryd returned malformed JSON.",
      "cli.protocol",
      response.status,
      "Check project-registryd logs or restart the daemon, then retry.",
    )
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
    const hint =
      typeof versionedError?.hint === "string"
        ? versionedError.hint
        : typeof envelope.hint === "string"
          ? envelope.hint
          : undefined
    return errorResult(resultOp, errorMessage, code, statusCode, hint)
  }
  if (envelope?.success !== true || !Object.hasOwn(envelope, "data")) {
    if (!response.ok) {
      return errorResult(
        op,
        `project-registryd returned HTTP ${response.status} ${response.statusText || "Error"}.`,
        "cli.server",
        response.status,
        "Check the daemon logs for the failed request, then retry.",
      )
    }
    return errorResult(
      op,
      "project-registryd returned a malformed response envelope.",
      "cli.protocol",
      response.status,
      "Check that project-registryd and the CLI use compatible versions, then retry.",
    )
  }
  if (!response.ok) {
    return errorResult(
      op,
      "project-registryd returned success with an error HTTP status.",
      "cli.protocol",
      response.status,
      "Check that project-registryd and the CLI use compatible versions, then retry.",
    )
  }
  return createResult(envelope.data)
}
