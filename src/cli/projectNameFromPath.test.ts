import { describe, expect, test } from "bun:test"
import type { Project } from "../project/Project.js"
import { projectNameFromPath } from "./projectNameFromPath.js"

function project(name: string, path: string): Project {
  return {
    schemaVersion: 1,
    owner: "david",
    name,
    type: "customer",
    order: Number.MAX_SAFE_INTEGER,
    services: [],
    labels: {},
    caddy: {
      port: 8000,
      domains: [`${name}.example`],
      path,
      access: "external",
      kind: "proxy",
      docs: true,
      browse: false,
      headerUp: {},
      disabled: false,
      denyDotfiles: false,
      spa: false,
    },
  }
}

describe("projectNameFromPath", () => {
  const projects = [
    project("assets-optimizer", "/home/david/adaptive/assets-optimizer"),
    project("zitadel-login", "/home/david/adaptive/zitadel-login"),
    project("nested-child", "/home/david/adaptive/zitadel-login/docs"),
  ]

  test("matches the exact registered project path", () => {
    const result = projectNameFromPath(projects, "/home/david/adaptive/assets-optimizer")

    expect(result).toEqual({ success: true, data: "assets-optimizer" })
  })

  test("matches a descendant of the registered project path", () => {
    const result = projectNameFromPath(projects, "/home/david/adaptive/assets-optimizer/src/cli")

    expect(result).toEqual({ success: true, data: "assets-optimizer" })
  })

  test("prefers the longest matching nested project path", () => {
    const result = projectNameFromPath(projects, "/home/david/adaptive/zitadel-login/docs/guide")

    expect(result).toEqual({ success: true, data: "nested-child" })
  })

  test("returns an error when no registered project matches", () => {
    const result = projectNameFromPath(projects, "/tmp/other")

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.op).toBe("projectNameFromPath")
  })

  test("does not match a path with only a shared prefix", () => {
    const result = projectNameFromPath([project("app", "/home/david/adaptive/app")], "/home/david/adaptive/app-extra")

    expect(result.success).toBe(false)
  })

  test("matches descendants of a project registered at the filesystem root", () => {
    const result = projectNameFromPath([project("root", "/")], "/tmp/project")

    expect(result).toEqual({ success: true, data: "root" })
  })

  test("matches descendants whose names begin with two dots", () => {
    const result = projectNameFromPath(
      [project("app", "/home/david/adaptive/app")],
      "/home/david/adaptive/app/..config",
    )

    expect(result).toEqual({ success: true, data: "app" })
  })
})
