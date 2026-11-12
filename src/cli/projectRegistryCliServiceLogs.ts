import { createResult, type Result } from "#result"
import type { ProjectRegistryCliFetch } from "./ProjectRegistryCliFetch.js"
import { projectRegistryCliRequest } from "./projectRegistryCliRequest.js"

/**
 * `svc logs`: the daemon answers with a plain-text journalctl stream (or a
 * JSON error envelope). Text is copied to stdout chunk by chunk so `-f`
 * follows live until the user interrupts.
 */
export async function projectRegistryCliServiceLogs(options: {
  socketPath: string
  name: string
  service?: string
  lines?: number
  follow?: boolean
  requestFetch: ProjectRegistryCliFetch
  stdout: (text: string) => void
}): Promise<Result<void>> {
  const query = new URLSearchParams()
  if (options.service !== undefined) query.set("service", options.service)
  if (options.lines !== undefined) query.set("lines", String(options.lines))
  if (options.follow === true) query.set("follow", "1")
  const suffix = query.toString() === "" ? "" : `?${query}`
  const path = `/api/v1/services/${encodeURIComponent(options.name)}/logs${suffix}`
  let response: Response
  try {
    response = await options.requestFetch(`http://localhost${path}`, {
      method: "GET",
      headers: { accept: "text/plain, application/json" },
      unix: options.socketPath,
    })
  } catch {
    // Reuse the shared transport error (message + hint).
    const errorR = await projectRegistryCliRequest(options.socketPath, path, {}, async () => {
      throw new Error("transport")
    })
    return errorR.success ? createResult(undefined) : errorR
  }
  if (!response.ok || !(response.headers.get("content-type") ?? "").startsWith("text/plain")) {
    const text = await response.text().catch(() => "")
    const errorR = await projectRegistryCliRequest(
      options.socketPath,
      path,
      {},
      async () => new Response(text, { status: response.status, headers: response.headers }),
    )
    return errorR.success ? createResult(undefined) : errorR
  }
  if (response.body === null) return createResult(undefined)
  const decoder = new TextDecoder()
  const reader = response.body.getReader()
  for (;;) {
    const chunk = await reader.read()
    if (chunk.done) break
    options.stdout(decoder.decode(chunk.value, { stream: true }))
  }
  const tail = decoder.decode()
  if (tail !== "") options.stdout(tail)
  return createResult(undefined)
}
