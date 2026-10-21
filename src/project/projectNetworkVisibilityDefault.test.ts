import { describe, expect, test } from "bun:test"
import { projectNetworkVisibilityDefault } from "./projectNetworkVisibilityDefault.js"

describe("projectNetworkVisibilityDefault", () => {
  test("defaults new leo and david routes to private", () => {
    expect(projectNetworkVisibilityDefault("leo")).toBe("private")
    expect(projectNetworkVisibilityDefault("david")).toBe("private")
  })

  test("keeps fabian, musa, and unknown owners public", () => {
    expect(projectNetworkVisibilityDefault("fabian")).toBe("public")
    expect(projectNetworkVisibilityDefault("musa")).toBe("public")
    expect(projectNetworkVisibilityDefault("someone-else")).toBe("public")
  })
})
