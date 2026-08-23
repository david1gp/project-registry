import { describe, expect, test } from "bun:test"
import pkg from "../../package.json" with { type: "json" }
import { projectRegistryCliRun } from "./projectRegistryCliRun.js"

const project = {
  name: "site",
  user: "david",
  port: 4321,
  domains: ["site.example"],
  kind: "proxy",
  access: "external",
}
const history = [{ sha: "1234567890abcdef", date: "2026-08-20T12:00:00Z", author: "Registry", message: "created" }]
const status = { desiredRevision: "new", appliedRevision: "old", pendingRevision: "new", pending: true }
const accessLogPage = {
  records: [
    {
      level: "info",
      ts: 1_755_757_341.418,
      logger: "http.log.access.example",
      msg: "handled request",
      request: {
        method: "GET",
        host: "site.example",
        uri: "/?download=full",
        client_ip: "192.0.2.23",
        headers: {
          authorization: ["Bearer secret"],
          cookie: ["session=secret"],
        },
      },
      duration: 0.125,
      size: 42,
      status: 200,
      resp_headers: { "content-type": ["application/json"] },
    },
  ],
  next: "next-cursor",
  partial: false,
  malformedLines: 0,
}

function mutation(action: "create" | "edit" | "delete", changed = true) {
  return {
    action,
    key: { owner: "david", name: "site" },
    changed,
    revision: "next-revision",
    localCommit: { status: changed ? "committed" : "unchanged", revision: "next-revision" },
    push: { requested: false, status: "not-requested" },
  }
}

function runOptions(data: unknown, paths: string[], stdout: string[], stderr: string[]) {
  return {
    environment: { USER: "david" },
    requestFetch: async (input: string | URL | Request) => {
      paths.push(new URL(String(input)).pathname + new URL(String(input)).search)
      return Response.json({ success: true, data })
    },
    stdout: (text: string) => stdout.push(text),
    stderr: (text: string) => stderr.push(text),
  }
}

describe("projectRegistryCliRun", () => {
  test.each([
    [["project", "list"], [project], "/projects"],
    [["project", "get", "site/name"], project, "/projects/site%2Fname"],
    [["project", "history", "site name", "--limit", "2"], history, "/history?name=site+name&limit=2"],
    [["history"], history, "/history"],
    [["history", "--limit=3"], history, "/history?limit=3"],
    [["config"], { apps: {} }, "/config"],
    [["config", "apps.http servers"], [], "/config?select=apps.http+servers"],
    [["status"], status, "/api/v1/caddy/status"],
  ] as const)("uses the read API path for %p", async (args, data, expectedPath) => {
    const paths: string[] = []
    const stdout: string[] = []
    const stderr: string[] = []

    const exitCode = await projectRegistryCliRun(args, runOptions(data, paths, stdout, stderr))

    expect(exitCode).toBe(0)
    expect(paths).toEqual([expectedPath])
    expect(stdout).toHaveLength(1)
    expect(stderr).toEqual([])
  })

  test("uses the selected socket for owner inference and keeps explicit owner authorization on the socket", async () => {
    const requests: Array<{ path: string; unix: string | undefined }> = []
    const requestFetch = async (input: string | URL | Request, init?: RequestInit & { unix?: string }) => {
      requests.push({ path: new URL(String(input)).pathname + new URL(String(input)).search, unix: init?.unix })
      return Response.json({ success: true, data: accessLogPage })
    }

    const inferredExit = await projectRegistryCliRun(
      [
        "project",
        "access-logs",
        "site",
        "--limit",
        "2",
        "--before",
        "cursor",
        "--socket",
        "/run/project-registry/leo.sock",
      ],
      { environment: { USER: "david" }, requestFetch, stdout: () => {} },
    )
    const explicitExit = await projectRegistryCliRun(
      ["project", "access-logs", "site", "--owner", "root", "--socket", "/run/project-registry/leo.sock"],
      {
        environment: { USER: "david" },
        requestFetch,
        stdout: () => {},
      },
    )

    expect(inferredExit).toBe(0)
    expect(explicitExit).toBe(0)
    expect(requests).toEqual([
      {
        path: "/api/v1/projects/site/access-logs?limit=2&before=cursor",
        unix: "/run/project-registry/leo.sock",
      },
      { path: "/api/v1/users/root/projects/site/access-logs", unix: "/run/project-registry/leo.sock" },
    ])
  })

  test("formats complete access-log records for humans and JSON", async () => {
    const human: string[] = []
    const humanExit = await projectRegistryCliRun(["project", "access-logs", "site"], {
      environment: { USER: "david" },
      requestFetch: async () => Response.json({ success: true, data: accessLogPage }),
      stdout: (text) => human.push(text),
    })
    const json: string[] = []
    const jsonExit = await projectRegistryCliRun(["project", "access-logs", "site", "--json"], {
      environment: { USER: "david" },
      requestFetch: async () => Response.json({ success: true, data: accessLogPage }),
      stdout: (text) => json.push(text),
    })

    expect(humanExit).toBe(0)
    expect(human.join("")).toBe(`${JSON.stringify(accessLogPage.records[0], null, 2)}\nNext: next-cursor\n`)
    expect(jsonExit).toBe(0)
    expect(JSON.parse(json.join("")).data.records).toEqual(accessLogPage.records)
    expect(json.join("")).toBe(`${JSON.stringify({ success: true, data: accessLogPage })}\n`)
  })

  test.each([400, 404, 410, 503] as const)("preserves typed access-log HTTP status %d", async (statusCode) => {
    const stderr: string[] = []
    const exitCode = await projectRegistryCliRun(["project", "access-logs", "site", "--json"], {
      environment: { USER: "david" },
      requestFetch: async () =>
        Response.json(
          {
            success: false,
            error: {
              code: statusCode === 503 ? "access-log.storage-unavailable" : "access-log.error",
              message: "access-log request failed",
              op: "projectAccessLogListUseCase",
              status: statusCode,
            },
          },
          { status: statusCode },
        ),
      stderr: (text) => stderr.push(text),
    })

    expect(exitCode).toBe(1)
    expect(JSON.parse(stderr.join(""))).toMatchObject({
      success: false,
      error: { status: statusCode },
    })
  })

  test("emits concise human project, history, status, and empty output", async () => {
    const cases = [
      { args: ["project", "list"], data: [project], output: "site\tproxy\t4321\tsite.example\n" },
      { args: ["project", "get", "site"], data: project, output: "site\tdavid\tproxy\t4321\tsite.example\n" },
      { args: ["history"], data: history, output: "12345678\t2026-08-20T12:00:00Z\tRegistry\tcreated\n" },
      { args: ["status"], data: status, output: "Caddy: pending\nDesired: new\nApplied: old\nPending: new\n" },
      { args: ["project", "list"], data: [], output: "No projects.\n" },
      { args: ["history"], data: [], output: "No history.\n" },
    ]

    for (const entry of cases) {
      const stdout: string[] = []
      const exitCode = await projectRegistryCliRun(entry.args, runOptions(entry.data, [], stdout, []))
      expect(exitCode).toBe(0)
      expect(stdout.join("")).toBe(entry.output)
    }
  })

  test("emits a stable JSON success envelope", async () => {
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["project", "list", "--json"], runOptions([project], [], stdout, []))

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.join(""))).toEqual({ success: true, data: [project] })
    expect(stdout.join("")).toBe(`${JSON.stringify({ success: true, data: [project] })}\n`)
  })

  test("creates with the current revision and exact nested Caddy payload", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(
      [
        "project",
        "create",
        "--name",
        "site",
        "--domain",
        "one.example",
        "--domain",
        "two.example",
        "--port",
        "4321",
        "--no-docs",
        "--header-up",
        "Host=localhost",
      ],
      {
        environment: { USER: "david" },
        requestFetch: async (input, init) => {
          requests.push({
            path: new URL(String(input)).pathname,
            method: init?.method ?? "GET",
            body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
          })
          if (init?.method === "POST")
            return Response.json({ success: true, data: mutation("create") }, { status: 201 })
          return Response.json({ success: true, data: { projects: [], revision: "current-revision" } })
        },
        stdout: (text) => stdout.push(text),
      },
    )

    expect(exitCode).toBe(0)
    expect(requests).toEqual([
      { path: "/api/v1/users/david/projects", method: "GET", body: undefined },
      {
        path: "/api/v1/users/david/projects",
        method: "POST",
        body: {
          expectedRevision: "current-revision",
          name: "site",
          caddy: {
            port: 4321,
            domains: ["one.example", "two.example"],
            docs: false,
            headerUp: { Host: "localhost" },
          },
        },
      },
    ])
    expect(stdout.join("")).toBe("created david/site\n")
  })

  test("edits with a minimal PATCH and preserves an API no-op", async () => {
    const requests: Array<{ method: string; body?: unknown }> = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["project", "edit", "site"], {
      environment: { USER: "david" },
      requestFetch: async (_input, init) => {
        requests.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })
        if (init?.method === "PATCH") return Response.json({ success: true, data: mutation("edit", false) })
        return Response.json({
          success: true,
          data: { project: { owner: "david", name: "site" }, revision: "current" },
        })
      },
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(requests).toEqual([
      { method: "GET", body: undefined },
      { method: "PATCH", body: { expectedRevision: "current" } },
    ])
    expect(stdout.join("")).toBe("unchanged david/site\n")
  })

  test("sends only supplied edit fields inside caddy", async () => {
    const bodies: unknown[] = []
    const exitCode = await projectRegistryCliRun(
      ["project", "edit", "site", "--enabled", "--no-spa", "--domain", "new.example"],
      {
        environment: { USER: "david" },
        requestFetch: async (_input, init) => {
          if (init?.method === "PATCH") {
            bodies.push(typeof init.body === "string" ? JSON.parse(init.body) : undefined)
            return Response.json({ success: true, data: mutation("edit") })
          }
          return Response.json({ success: true, data: { project: {}, revision: "current" } })
        },
        stdout: () => {},
      },
    )

    expect(exitCode).toBe(0)
    expect(bodies).toEqual([
      { expectedRevision: "current", caddy: { domains: ["new.example"], disabled: false, spa: false } },
    ])
  })

  test("deletes directly with the fetched revision, matching the legacy non-confirming behavior", async () => {
    const requests: Array<{ method: string; body?: unknown }> = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["project", "delete", "site"], {
      environment: { USER: "david" },
      requestFetch: async (_input, init) => {
        requests.push({
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })
        if (init?.method === "DELETE") return Response.json({ success: true, data: mutation("delete") })
        return Response.json({ success: true, data: { project: {}, revision: "current" } })
      },
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(requests).toEqual([
      { method: "GET", body: undefined },
      { method: "DELETE", body: { expectedRevision: "current" } },
    ])
    expect(stdout.join("")).toBe("deleted david/site\n")
  })

  test("deletes the current owner's project by port through the legacy API route", async () => {
    const requests: Array<{ path: string; method: string; body?: unknown }> = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["delete", "--port", "4321"], {
      environment: { USER: "david" },
      requestFetch: async (input, init) => {
        requests.push({
          path: new URL(String(input)).pathname,
          method: init?.method ?? "GET",
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        })
        return Response.json({ success: true, data: { deleted: "site" } })
      },
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(requests).toEqual([{ path: "/projects/by-port/4321", method: "DELETE", body: undefined }])
    expect(stdout.join("")).toBe("deleted david/site\n")
  })

  test("preserves the legacy delete-by-port response in JSON output", async () => {
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["delete", "--port", "4321", "--json"], {
      environment: { USER: "david" },
      requestFetch: async () => Response.json({ success: true, data: { deleted: "site" } }),
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(JSON.parse(stdout.join(""))).toEqual({ success: true, data: { deleted: "site" } })
  })

  test("keeps explicit-name docs direct without a project lookup", async () => {
    const requests: string[] = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["docs", "site", "guide/intro.md", "--http"], {
      environment: { USER: "david" },
      requestFetch: async (input) => {
        requests.push(new URL(String(input)).pathname + new URL(String(input)).search)
        return Response.json({ success: true, data: { urls: ["http://site.example/docs/guide/intro.md"] } })
      },
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(requests).toEqual(["/api/v1/users/david/projects/site/docs?path=guide%2Fintro.md&scheme=http"])
    expect(stdout.join("")).toBe("http://site.example/docs/guide/intro.md\n")
  })

  test("resolves local documentation from the current working directory before requesting docs", async () => {
    const requests: string[] = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["docs", "guide/intro.md"], {
      environment: { USER: "david" },
      requestFetch: async (input) => {
        const path = new URL(String(input)).pathname + new URL(String(input)).search
        requests.push(path)
        if (path === "/api/v1/users/david/projects") {
          return Response.json({
            success: true,
            data: {
              projects: [
                {
                  schemaVersion: 1,
                  owner: "david",
                  name: "site",
                  type: "customer",
                  order: Number.MAX_SAFE_INTEGER,
                  services: [],
                  caddy: {
                    port: 4321,
                    domains: ["site.example"],
                    path: process.cwd(),
                  },
                },
              ],
              revision: "current",
            },
          })
        }
        return Response.json({ success: true, data: { urls: ["https://site.example/docs/guide/intro.md"] } })
      },
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(requests).toEqual([
      "/api/v1/users/david/projects",
      "/api/v1/users/david/projects/site/docs?path=guide%2Fintro.md",
    ])
    expect(stdout.join("")).toBe("https://site.example/docs/guide/intro.md\n")
  })

  test("reports a clear error and skips the docs request when no local project matches", async () => {
    const requests: string[] = []
    const stderr: string[] = []
    const exitCode = await projectRegistryCliRun(["docs", "guide/intro.md"], {
      environment: { USER: "david" },
      requestFetch: async (input) => {
        requests.push(new URL(String(input)).pathname)
        return Response.json({
          success: true,
          data: {
            projects: [
              {
                schemaVersion: 1,
                owner: "david",
                name: "other",
                type: "customer",
                order: Number.MAX_SAFE_INTEGER,
                services: [],
                caddy: { port: 4321, domains: ["other.example"], path: "/tmp/other" },
              },
            ],
            revision: "current",
          },
        })
      },
      stderr: (text) => stderr.push(text),
    })

    expect(exitCode).toBe(1)
    expect(requests).toEqual(["/api/v1/users/david/projects"])
    expect(stderr.join("")).toBe(`error: no project matches cwd: ${process.cwd()}\n`)
  })

  test("regenerates through the versioned POST endpoint", async () => {
    const requests: Array<{ path: string; method: string }> = []
    const stdout: string[] = []
    const exitCode = await projectRegistryCliRun(["regenerate"], {
      environment: { USER: "david" },
      requestFetch: async (input, init) => {
        requests.push({ path: new URL(String(input)).pathname, method: init?.method ?? "GET" })
        return Response.json({
          success: true,
          data: { revision: "current", changed: false, applied: true, attempts: 1 },
        })
      },
      stdout: (text) => stdout.push(text),
    })

    expect(exitCode).toBe(0)
    expect(requests).toEqual([{ path: "/api/v1/caddy/regenerate", method: "POST" }])
    expect(stdout.join("")).toBe("regenerated\n")
  })

  test.each([
    [["project", "create", "--name", "site", "--domain", "site.example"], "POST"],
    [["project", "edit", "site", "--docs"], "PATCH"],
    [["project", "delete", "site"], "DELETE"],
    [["delete", "--port", "4321"], "DELETE"],
  ] as const)("preserves mutation errors for %p", async (args, mutationMethod) => {
    const stderr: string[] = []
    const exitCode = await projectRegistryCliRun(args, {
      environment: { USER: "david" },
      requestFetch: async (_input, init) => {
        if (init?.method === mutationMethod) {
          return Response.json(
            {
              success: false,
              error: {
                code: "projects.conflict",
                message: "revision mismatch",
                op: "projectRepositoryMutation",
                status: 409,
              },
            },
            { status: 409 },
          )
        }
        return Response.json({ success: true, data: { projects: [], project: {}, revision: "stale" } })
      },
      stderr: (text) => stderr.push(text),
    })

    expect(exitCode).toBe(1)
    expect(stderr.join("")).toBe("error: revision mismatch\n")
  })

  test.each([
    [["docs", "site", "guide.md"], "projects.not-found"],
    [["regenerate"], "caddy.unavailable"],
  ] as const)("preserves operational command errors for %p", async (args, code) => {
    const stderr: string[] = []
    const exitCode = await projectRegistryCliRun(args, {
      environment: { USER: "david" },
      requestFetch: async () =>
        Response.json(
          { success: false, error: { code, message: "operation failed", op: "operation", status: 503 } },
          { status: 503 },
        ),
      stderr: (text) => stderr.push(text),
    })

    expect(exitCode).toBe(1)
    expect(stderr.join("")).toBe("error: operation failed\n")
  })

  test("emits stable JSON errors and deterministic exit codes", async () => {
    const usageError: string[] = []
    const usageExit = await projectRegistryCliRun(["status", "--owner", "david", "--json"], {
      stderr: (text) => usageError.push(text),
    })
    const serverError: string[] = []
    const serverExit = await projectRegistryCliRun(["status", "--json"], {
      environment: { USER: "david" },
      requestFetch: async () =>
        Response.json(
          {
            success: false,
            error: { code: "caddy.unavailable", message: "Caddy is unavailable.", op: "caddyStatus", status: 503 },
          },
          { status: 503 },
        ),
      stderr: (text) => serverError.push(text),
    })

    expect(usageExit).toBe(2)
    expect(JSON.parse(usageError.join(""))).toEqual({
      success: false,
      error: {
        code: "cli.usage",
        message: "Unknown or invalid command: status.",
        op: "projectRegistryCliArgumentsParse",
        status: null,
      },
    })
    expect(serverExit).toBe(1)
    expect(JSON.parse(serverError.join(""))).toEqual({
      success: false,
      error: { code: "caddy.unavailable", message: "Caddy is unavailable.", op: "caddyStatus", status: 503 },
    })
  })

  test("does not request the daemon for untrusted owner input, help, or version", async () => {
    let requests = 0
    const output: string[] = []
    const options = {
      requestFetch: async () => {
        requests += 1
        return Response.json({ success: true, data: {} })
      },
      stdout: (text: string) => output.push(text),
      stderr: (text: string) => output.push(text),
    }

    expect(await projectRegistryCliRun(["project", "list", "--owner", "root"], options)).toBe(2)
    expect(await projectRegistryCliRun(["--help"], options)).toBe(0)
    expect(await projectRegistryCliRun(["--version"], options)).toBe(0)
    expect(requests).toBe(0)
    expect(output.join("")).toContain("Usage: project-registry")
    expect(output.join("")).toContain("delete --port <port>")
    expect(output.join("")).toContain(`project-registry ${pkg.version}`)
  })

  test("rejects malformed command data", async () => {
    const stderr: string[] = []
    const exitCode = await projectRegistryCliRun(["project", "list"], runOptions([{ user: "david" }], [], [], stderr))

    expect(exitCode).toBe(1)
    expect(stderr.join("")).toBe("error: project-registryd returned malformed project list data.\n")
  })
})
