import { describe, expect, test } from "bun:test"
import { projectRegistryCliRequest } from "./projectRegistryCliRequest.js"

describe("projectRegistryCliRequest", () => {
  test("sends GET HTTP over the selected Unix socket and unwraps success", async () => {
    const requests: Array<{ url: string; init?: RequestInit & { unix?: string } }> = []
    const requestFetch = async (input: string | URL | Request, init?: RequestInit & { unix?: string }) => {
      requests.push({ url: String(input), init })
      return Response.json({ success: true, data: { value: 1 } })
    }

    const result = await projectRegistryCliRequest("/run/project-registry/david.sock", "/projects", requestFetch)

    expect(result).toEqual({ success: true, data: { value: 1 } })
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toBe("http://localhost/projects")
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      headers: { accept: "application/json" },
      unix: "/run/project-registry/david.sock",
    })
  })

  test("preserves an ownerless access-log path on the selected Unix socket", async () => {
    const requests: Array<{ url: string; init?: RequestInit & { unix?: string } }> = []
    const requestFetch = async (input: string | URL | Request, init?: RequestInit & { unix?: string }) => {
      requests.push({ url: String(input), init })
      return Response.json({ success: true, data: { records: [] } })
    }

    const result = await projectRegistryCliRequest(
      "/run/project-registry/leo.sock",
      "/api/v1/projects/site/access-logs?limit=2",
      requestFetch,
    )

    expect(result).toEqual({ success: true, data: { records: [] } })
    expect(requests[0]?.url).toBe("http://localhost/api/v1/projects/site/access-logs?limit=2")
    expect(requests[0]?.init).toMatchObject({ unix: "/run/project-registry/leo.sock" })
  })

  test.each([
    ["POST", "/projects", { name: "site" }],
    ["PATCH", "/projects/site", { expectedRevision: "revision", caddy: { docs: false } }],
    ["DELETE", "/projects/site", { expectedRevision: "revision" }],
  ] as const)("sends %s JSON requests", async (method, path, body) => {
    const requests: Array<{ init?: RequestInit & { unix?: string } }> = []
    const result = await projectRegistryCliRequest(
      "/run/project-registry/david.sock",
      path,
      { method, body },
      async (_input, init) => {
        requests.push({ init })
        return Response.json({ success: true, data: { changed: true } })
      },
    )

    expect(result).toEqual({ success: true, data: { changed: true } })
    expect(requests[0]?.init).toMatchObject({
      method,
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
      unix: "/run/project-registry/david.sock",
    })
  })

  test("normalizes versioned and legacy server error envelopes", async () => {
    const versioned = await projectRegistryCliRequest("/socket", "/status", async () =>
      Response.json(
        {
          success: false,
          error: { code: "caddy.forbidden", message: "Access is forbidden.", op: "configGet", status: 403 },
        },
        { status: 403 },
      ),
    )
    const legacy = await projectRegistryCliRequest("/socket", "/projects", async () =>
      Response.json(
        { success: false, code: "projects.not-found", errorMessage: "The project was not found.", op: "projectGet" },
        { status: 404 },
      ),
    )

    expect(versioned).toEqual({
      success: false,
      code: "caddy.forbidden",
      errorMessage: "Access is forbidden.",
      op: "configGet",
      statusCode: 403,
    })
    expect(legacy).toEqual({
      success: false,
      code: "projects.not-found",
      errorMessage: "The project was not found.",
      op: "projectGet",
      statusCode: 404,
    })
  })

  test.each([
    [new Response("not json"), "cli.protocol", "project-registryd returned malformed JSON."],
    [Response.json({ data: [] }), "cli.protocol", "project-registryd returned a malformed response envelope."],
    [
      Response.json({ success: true, data: [] }, { status: 500 }),
      "cli.protocol",
      "project-registryd returned success with an error HTTP status.",
    ],
    [
      new Response("unavailable", { status: 503, statusText: "Unavailable" }),
      "cli.server",
      "project-registryd returned HTTP 503 Unavailable.",
    ],
  ])("rejects malformed responses", async (response, code, message) => {
    const result = await projectRegistryCliRequest("/socket", "/projects", async () => response)

    expect(result).toMatchObject({ success: false, code, errorMessage: message })
  })

  test("returns a deterministic transport error", async () => {
    const result = await projectRegistryCliRequest("/missing.sock", "/projects", async () => {
      throw new Error("secret platform detail")
    })

    expect(result).toEqual({
      success: false,
      code: "cli.transport",
      errorMessage: "Could not communicate with project-registryd over /missing.sock.",
      op: "projectRegistryCliRequest",
      statusCode: undefined,
    })
  })
})
