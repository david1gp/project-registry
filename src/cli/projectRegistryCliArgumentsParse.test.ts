import { describe, expect, test } from "bun:test"
import { projectRegistryCliArgumentsParse } from "./projectRegistryCliArgumentsParse.js"

describe("projectRegistryCliArgumentsParse", () => {
  test.each([
    [["project", "list"], { kind: "project-list" }],
    [["project", "get", "site"], { kind: "project-get", name: "site" }],
    [
      ["project", "create", "--name", "site", "--domain", "site.example"],
      { kind: "project-create", name: "site", caddy: { domains: ["site.example"] } },
    ],
    [["project", "edit", "site"], { kind: "project-edit", name: "site", caddy: {} }],
    [["project", "delete", "site"], { kind: "project-delete", name: "site" }],
    [["project", "history", "site"], { kind: "project-history", name: "site", limit: undefined }],
    [["project", "history", "site", "--limit", "5"], { kind: "project-history", name: "site", limit: 5 }],
    [
      ["project", "access-logs", "site"],
      { kind: "project-access-logs", name: "site", owner: undefined, limit: undefined, before: undefined },
    ],
    [
      ["project", "access-logs", "site", "--owner", "root", "--limit", "25", "--before=cursor"],
      { kind: "project-access-logs", name: "site", owner: "root", limit: 25, before: "cursor" },
    ],
    [["history", "--limit=7"], { kind: "history", limit: 7 }],
    [["docs", "site", "guide/intro.md"], { kind: "docs", name: "site", path: "guide/intro.md", http: false }],
    [["docs", "site", "guide/intro.md", "--http"], { kind: "docs", name: "site", path: "guide/intro.md", http: true }],
    [["config"], { kind: "config", selector: undefined }],
    [["config", "apps.http.servers"], { kind: "config", selector: "apps.http.servers" }],
    [["status"], { kind: "status" }],
    [["regenerate"], { kind: "regenerate" }],
    [["--help"], { kind: "help" }],
    [["-V"], { kind: "version" }],
  ] as const)("parses %p", (args, command) => {
    const result = projectRegistryCliArgumentsParse(args)

    expect(result as unknown).toEqual({ success: true, data: { command, json: false, socket: undefined } })
  })

  test("accepts global options without treating a socket as identity", () => {
    const result = projectRegistryCliArgumentsParse([
      "project",
      "get",
      "site",
      "--json",
      "--socket=/run/project-registry/other.sock",
    ])

    expect(result).toEqual({
      success: true,
      data: {
        command: { kind: "project-get", name: "site" },
        json: true,
        socket: "/run/project-registry/other.sock",
      },
    })
  })

  test("parses repeated values, booleans, and all legacy-compatible Caddy flags", () => {
    const result = projectRegistryCliArgumentsParse([
      "project",
      "create",
      "--name=site",
      "--port",
      "4321",
      "--domain",
      "one.example",
      "--domain=two.example",
      "--path=/srv/site",
      "--kind",
      "static",
      "--access=internal",
      "--no-docs",
      "--browse",
      "--disabled",
      "--spa",
      "--header-up",
      "Host=localhost",
      "--header-up=X-Test=one=two",
      "--flush-interval",
      "-1",
    ])

    expect(result).toEqual({
      success: true,
      data: {
        command: {
          kind: "project-create",
          name: "site",
          caddy: {
            port: 4321,
            domains: ["one.example", "two.example"],
            path: "/srv/site",
            kind: "static",
            access: "internal",
            docs: false,
            browse: true,
            disabled: true,
            spa: true,
            headerUp: { Host: "localhost", "X-Test": "one=two" },
            flushInterval: -1,
          },
        },
        json: false,
        socket: undefined,
      },
    })
  })

  test.each([
    ["--docs", "--no-docs"],
    ["--browse", "--no-browse"],
    ["--disabled", "--enabled"],
    ["--spa", "--no-spa"],
  ])("rejects conflicting boolean pair %s/%s", (on, off) => {
    const result = projectRegistryCliArgumentsParse(["project", "edit", "site", on, off])

    expect(result).toMatchObject({ success: false, errorMessage: `Options ${on} and ${off} cannot be combined.` })
  })

  test.each([
    [[], "A command is required."],
    [["project", "get"], "Unknown or invalid command: project get."],
    [["project", "list", "extra"], "Unknown or invalid command: project list extra."],
    [["project", "list", "--limit", "2"], "Unknown or invalid command: project list."],
    [["project", "create", "--name", "site"], "Project create requires at least one --domain."],
    [["project", "create", "--domain", "site.example"], "Project create requires --name."],
    [["project", "edit", "site", "--name", "renamed"], "Option --name cannot edit an immutable project name."],
    [["project", "delete", "site", "--port", "4321"], "Unknown or invalid command: project delete site."],
    [["docs", "site"], "Unknown or invalid command: docs site."],
    [["docs", "site", "guide.md", "--docs"], "Unknown or invalid command: docs site guide.md."],
    [["project", "edit", "site", "--header-up", "invalid"], "Option --header-up requires K=V, got: invalid."],
    [["project", "edit", "site", "--port", "0"], "Option --port requires an integer from 1 through 65535."],
    [["project", "edit", "site", "--flush-interval=NaN"], "Option --flush-interval requires a finite number."],
    [["history", "--limit", "0"], "Option --limit requires a positive integer."],
    [["history", "--limit=9007199254740992"], "Option --limit requires a positive integer."],
    [["status", "--owner", "leo"], "Unknown or invalid command: status."],
    [["project", "access-logs", "site", "--limit", "1001"], "Option --limit for access logs must not exceed 1000."],
    [["project", "access-logs", "site", "--owner", "../root"], "Option --owner requires a valid Unix username."],
    [["project", "access-logs", "site", "--before"], "Option --before requires a bounded cursor."],
    [["project", "access-logs", "site", "--before", "--json"], "Option --before requires a bounded cursor."],
    [["project", "access-logs", "site", "--before", "--limit", "25"], "Option --before requires a bounded cursor."],
    [["project", "access-logs", "site", "--before="], "Option --before requires a bounded cursor."],
    [["project", "access-logs", "site", "--follow"], "Unknown option: --follow."],
    [["status", "--socket"], "Option --socket requires a path."],
    [["status", "--json", "--json"], "Option --json may only be provided once."],
    [["--help", "--version"], "Options --help and --version cannot be combined."],
  ] as const)("rejects invalid arguments %p", (args, message) => {
    const result = projectRegistryCliArgumentsParse(args)

    expect(result).toMatchObject({ success: false, op: "projectRegistryCliArgumentsParse", errorMessage: message })
  })
})
