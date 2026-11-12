import { describe, expect, test } from "bun:test"
import { devRootsParse } from "./devRootsParse.js"

describe("devRootsParse", () => {
  test("parses per-root user allowlists", () => {
    expect(devRootsParse("/projects:leo,david,tim,mit")).toEqual({
      success: true,
      data: [{ path: "/projects", users: ["leo", "david", "tim", "mit"] }],
    })
  })

  test("parses several roots and a * root open to every user", () => {
    const result = devRootsParse(" /projects/:leo, tim ; /srv/shared:* ")
    expect(result).toEqual({
      success: true,
      data: [{ path: "/projects", users: ["leo", "tim"] }, { path: "/srv/shared" }],
    })
  })

  test("fails closed on malformed entries", () => {
    for (const value of [
      "",
      "/projects",
      "projects:leo",
      "/projects:",
      "/projects:leo;/projects:tim",
      "/projects:leo,*",
      "/projects:leo;rm -rf",
      "/projects:le o",
    ]) {
      expect(devRootsParse(value).success).toBe(false)
    }
  })
})
