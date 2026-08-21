import { describe, expect, test } from "bun:test"
import { projectAccessLogId } from "./projectAccessLogId.js"
import { projectAccessLogPath } from "./projectAccessLogPath.js"

describe("projectAccessLogPath", () => {
  test("derives a stable path without exposing project components", () => {
    const project = { owner: "alice/../other", name: "catalog\\logs" }
    const result = projectAccessLogPath("/var/lib/project-registry/logs", project)

    expect(result).toEqual({
      success: true,
      data: `/var/lib/project-registry/logs/projects/${projectAccessLogId(project)}/access.jsonl`,
    })
    if (result.success) {
      expect(result.data).not.toContain(project.owner)
      expect(result.data).not.toContain(project.name)
    }
  })

  test("rejects ambiguous or unsafe log roots", () => {
    for (const root of [
      "relative",
      "/",
      "/var/logs/../other",
      "/var/logs/./access",
      "/var/logs/",
      "/var/logs\\access",
      "/var/\0logs",
    ]) {
      expect(projectAccessLogPath(root, { owner: "alice", name: "catalog" }).success).toBe(false)
    }
  })
})
