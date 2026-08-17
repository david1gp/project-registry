import { beforeEach, describe, expect, test } from "bun:test"
import { projectGet } from "./projectGet.js"
import { projectList } from "./projectList.js"
import { projectRegister } from "./projectRegister.js"
import { projectRegistryStore } from "./projectRegistryStore.js"

describe("projectRegister", () => {
  beforeEach(() => {
    projectRegistryStore.clear()
  })

  test("registers a project by name", () => {
    const result = projectRegister({ name: "project-registry", description: "catalog" })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.id).toBe("project-registry")
    expect(projectGet("project-registry").success).toBe(true)
    expect(projectList().data).toHaveLength(1)
  })

  test("rejects empty and duplicate names", () => {
    expect(projectRegister({ name: "  ", description: "x" }).success).toBe(false)
    projectRegister({ name: "utils", description: "helpers" })
    expect(projectRegister({ name: "utils", description: "again" }).success).toBe(false)
  })
})
