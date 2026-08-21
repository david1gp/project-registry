import { describe, expect, test } from "bun:test"
import { zitadelIdentityDirectoryCreate } from "./zitadelIdentityDirectoryCreate.js"

const options = {
  issuer: "https://zitadel.example",
  orgId: "org-1",
  projectId: "project-1",
}

function grant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    userId: "subject-1",
    preferredLoginName: "alice",
    projectId: "project-1",
    orgId: "org-1",
    roleKeys: ["own"],
    state: "USER_GRANT_STATE_ACTIVE",
    ...overrides,
  }
}

function response(result: readonly Record<string, unknown>[], total = result.length): Response {
  return new Response(JSON.stringify({ details: { totalResult: total }, result }), { status: 200 })
}

describe("Zitadel identity directory", () => {
  test("lists current project users with bounded pagination and the configured bearer", async () => {
    const requests: { input: string; init: RequestInit }[] = []
    const http = async (input: string, init: RequestInit): Promise<Response> => {
      requests.push({ input, init })
      const body = JSON.parse(String(init.body)) as { query: { offset: number } }
      if (body.query.offset === 0) {
        return response(
          Array.from({ length: 100 }, (_, index) =>
            grant({
              userId: `subject-${index + 1}`,
              preferredLoginName: index === 0 ? "alice" : `user-${index + 1}`,
            }),
          ),
          101,
        )
      }
      return response([grant({ userId: "subject-101", preferredLoginName: "bob", roleKeys: ["admin"] })], 101)
    }
    const directoryR = zitadelIdentityDirectoryCreate({ ...options, http })
    expect(directoryR.success).toBe(true)
    if (!directoryR.success) return

    const usersR = await directoryR.data.usersList("browser-token")
    expect(usersR).toEqual({
      success: true,
      data: [
        { subject: "subject-1", preferredUsername: "alice" },
        ...Array.from({ length: 99 }, (_, index) => ({
          subject: `subject-${index + 2}`,
          preferredUsername: `user-${index + 2}`,
        })),
        { subject: "subject-101", preferredUsername: "bob" },
      ],
    })
    expect(requests).toHaveLength(2)
    expect(requests[0]?.input).toBe("https://zitadel.example/management/v1/users/grants/_search")
    expect(requests[0]?.init.headers).toEqual({
      accept: "application/json",
      authorization: "Bearer browser-token",
      "content-type": "application/json",
      "x-zitadel-orgid": "org-1",
    })
    expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
      query: { offset: 0, limit: 100, asc: true },
      queries: [{ projectIdQuery: { projectId: "project-1" } }],
    })
  })

  test("resolves preferred usernames and current project roles without trusting the search filter", async () => {
    const http = async (_input: string, init: RequestInit): Promise<Response> => {
      const body = JSON.parse(String(init.body)) as { queries: readonly Record<string, unknown>[] }
      expect(body.queries).toEqual([{ userIdQuery: { userId: "subject-1" } }])
      return response([
        grant({ roleKeys: ["admin"] }),
        grant({ projectId: "another-project", orgId: "org-1", roleKeys: ["superadmin"] }),
        grant({ projectId: "project-1", orgId: "org-1", state: "USER_GRANT_STATE_INACTIVE" }),
      ])
    }
    const directoryR = zitadelIdentityDirectoryCreate({ ...options, http })
    expect(directoryR.success).toBe(true)
    if (!directoryR.success) return

    expect(await directoryR.data.userPreferredUsernameResolve("subject-1", "runtime-token")).toEqual({
      success: true,
      data: "alice",
    })
    expect(await directoryR.data.userRolesList("subject-1", "runtime-token")).toEqual({
      success: true,
      data: ["admin"],
    })
  })

  test("fails closed for non-success, malformed, duplicate, and over-limit responses", async () => {
    let body: unknown = { result: [], details: { totalResult: 0 } }
    const http = async (): Promise<Response> => {
      if (body === "http") return new Response(null, { status: 403 })
      return new Response(JSON.stringify(body), { status: 200 })
    }
    const directoryR = zitadelIdentityDirectoryCreate({ ...options, http, maxResults: 1 })
    expect(directoryR.success).toBe(true)
    if (!directoryR.success) return

    body = { result: [grant(), grant({ userId: "subject-1" })], details: { totalResult: 2 } }
    expect((await directoryR.data.usersList("token")).success).toBe(false)
    body = { result: [], details: { totalResult: 2 } }
    expect((await directoryR.data.usersList("token")).success).toBe(false)
    body = { result: [grant({ userId: "other-subject" })], details: { totalResult: 1 } }
    expect((await directoryR.data.userRolesList("subject-1", "token")).success).toBe(false)
    body = "http"
    expect((await directoryR.data.usersList("token")).success).toBe(false)
    expect((await directoryR.data.userRolesList("subject-1", "bad\nheader")).success).toBe(false)
  })

  test("rejects unknown current project roles and missing current grants", async () => {
    let current = grant({ roleKeys: ["operator"] })
    const http = async (): Promise<Response> => response([current])
    const directoryR = zitadelIdentityDirectoryCreate({ ...options, http })
    expect(directoryR.success).toBe(true)
    if (!directoryR.success) return

    expect((await directoryR.data.userRolesList("subject-1", "token")).success).toBe(false)
    current = grant({ state: "USER_GRANT_STATE_INACTIVE" })
    expect((await directoryR.data.userPreferredUsernameResolve("subject-1", "token")).success).toBe(false)
  })
})
