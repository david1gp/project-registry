import { describe, expect, test } from "bun:test"
import { hostsManagedBlockRender } from "./hostsManagedBlockRender.js"

describe("hostsManagedBlockRender", () => {
  test("normalizes, deduplicates, and sorts domains into stable loopback entries", () => {
    const result = hostsManagedBlockRender([" API.Dev. ", "www.dev", "api.dev"])
    expect(result).toEqual({
      success: true,
      data: "# BEGIN project-registry managed hosts\n127.0.0.1 api.dev\n127.0.0.1 www.dev\n# END project-registry managed hosts\n",
    })
  })

  test("rejects hostname injection and invalid labels", () => {
    expect(hostsManagedBlockRender(["ok.dev\n127.0.0.1 injected"]).success).toBe(false)
    expect(hostsManagedBlockRender(["-invalid.dev"]).success).toBe(false)
  })
})
