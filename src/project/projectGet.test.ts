import { describe, expect, test } from "bun:test"
import { projectGet } from "./projectGet.js"
import { projectNormalize } from "./projectNormalize.js"
import type { Project } from "./projectSchema.js"

function project(owner: string, name: string): Project {
  const result = projectNormalize({ owner, name })
  if (!result.success) throw new Error(result.errorMessage)
  return result.data
}

describe("projectGet", () => {
  test("looks up a project with a slash-containing owner structurally", () => {
    const expected = project("a/b", "c")
    const result = projectGet([expected], { owner: "a/b", name: "c" })

    expect(result).toMatchObject({ success: true, data: expected })
  })

  test("does not match delimiter-colliding key components", () => {
    const result = projectGet([project("a/b", "c")], { owner: "a", name: "b/c" })

    expect(result.success).toBe(false)
  })
})
