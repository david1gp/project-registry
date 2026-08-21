import { describe, expect, test } from "bun:test"
import { projectAccessLogClientGet } from "./projectAccessLogClientGet.js"

describe("projectAccessLogClientGet", () => {
  test("uses the ownerful encoded route and forwards the paging cursor", async () => {
    let requestedUrl = ""
    let requestedInit: RequestInit | undefined
    const result = await projectAccessLogClientGet(
      "team user",
      "web/app",
      { limit: 25, before: "cursor +/=" },
      async (url, init) => {
        requestedUrl = url.toString()
        requestedInit = init
        return Response.json({
          success: true,
          data: { records: [], next: "older", partial: false, malformedLines: 0 },
        })
      },
    )

    expect(result).toEqual({
      success: true,
      data: { records: [], next: "older", partial: false, malformedLines: 0 },
    })
    expect(requestedUrl).toBe(
      "/api/v1/users/team%20user/projects/web%2Fapp/access-logs?limit=25&before=cursor+%2B%2F%3D",
    )
    expect((requestedInit?.headers as Record<string, string> | undefined)?.accept).toBe("application/json")
  })

  test("preserves expired and unavailable API errors", async () => {
    for (const [status, code] of [
      [410, "access-log.cursor-expired"],
      [503, "access-log.unavailable"],
    ] as const) {
      const result = await projectAccessLogClientGet("leo", "app", {}, async () =>
        Response.json({ success: false, error: { code, message: "failed" } }, { status }),
      )
      expect(result).toMatchObject({ success: false, code, statusCode: status })
    }
  })

  test("rejects malformed successful data", async () => {
    const result = await projectAccessLogClientGet("leo", "app", {}, async () =>
      Response.json({ success: true, data: { records: "not-an-array" } }),
    )
    expect(result).toMatchObject({ success: false, code: "response.malformed", statusCode: 200 })
  })

  test("aborts and settles a request that exceeds the client timeout", async () => {
    let signal: AbortSignal | undefined
    const result = await projectAccessLogClientGet("leo", "app", { timeoutMilliseconds: 5 }, async (_url, init) => {
      signal = init?.signal ?? undefined
      return new Promise<Response>(() => {})
    })

    expect(result).toMatchObject({ success: false, code: "request.aborted" })
    expect(signal?.aborted).toBe(true)
  })
})
