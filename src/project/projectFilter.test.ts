import { describe, expect, test } from "bun:test"
import { projectFilter } from "./projectFilter.js"

describe("projectFilter", () => {
  const sampleProjects = [
    {
      name: "authworks-site",
      user: "david",
      labels: {
        sourcePath: "/home/david/adaptive/authworks-site",
        section: "Adaptive",
        code: "https://git.contentoren.de/david/authworks-site",
      },
    },
    {
      name: "opencode-david",
      user: "david",
      labels: {
        section: "Entwicklung Infrastruktur",
        "service.opencode": "opencode.service",
        sourcePath: "/home/david/opensource/opencode",
        code: "https://github.com/anomalyco/opencode",
      },
    },
    {
      name: "codex-lb",
      user: "david",
      labels: {
        section: "Infrastruktur Produktion",
        officialUrl: "https://github.com/Soju06/codex-lb/",
        logo: "/logos/codex-lb-chatgpt.svg",
      },
    },
    {
      name: "crm",
      user: "david",
      labels: {},
    },
  ]

  test("returns all projects when criteria are empty", () => {
    const result = projectFilter(sampleProjects, {})
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.length).toBe(4)
  })

  test("filters by section (case-insensitive and trimmed)", () => {
    const result = projectFilter(sampleProjects, { section: " adaptive " })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.map((p) => p.name)).toEqual(["authworks-site"])
  })

  test("filters by multiple metadata key=value fields", () => {
    const result = projectFilter(sampleProjects, {
      metadata: {
        section: "Entwicklung Infrastruktur",
        code: "https://github.com/anomalyco/opencode",
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.map((p) => p.name)).toEqual(["opencode-david"])
  })

  test("filters by metadata key presence when value is undefined or empty", () => {
    const result = projectFilter(sampleProjects, {
      metadata: {
        logo: undefined,
      },
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data.map((p) => p.name)).toEqual(["codex-lb"])
  })

  test("combines section and metadata filters with AND logic", () => {
    const mismatch = projectFilter(sampleProjects, {
      section: "Adaptive",
      metadata: { officialUrl: "https://github.com/Soju06/codex-lb/" },
    })
    expect(mismatch.success).toBe(true)
    if (!mismatch.success) return
    expect(mismatch.data.length).toBe(0)
  })
})
