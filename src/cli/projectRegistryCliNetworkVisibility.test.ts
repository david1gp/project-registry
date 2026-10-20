import { describe, expect, test } from "bun:test"
import { projectRegistryCliArgumentsParse } from "./projectRegistryCliArgumentsParse.js"
import { projectRegistryCliHelp } from "./projectRegistryCliHelp.js"

describe("projectRegistryCliArgumentsParse networkVisibility", () => {
  test("parses public and private visibility on project create", () => {
    for (const networkVisibility of ["public", "private"] as const) {
      const result = projectRegistryCliArgumentsParse([
        "project",
        "create",
        "--name=site",
        "--domain=site.example",
        `--network-visibility=${networkVisibility}`,
      ])

      expect(result).toEqual({
        success: true,
        data: {
          command: {
            kind: "project-create",
            name: "site",
            caddy: { domains: ["site.example"], networkVisibility },
          },
          json: false,
          socket: undefined,
        },
      })
    }
  })

  test("parses visibility on project edit", () => {
    const result = projectRegistryCliArgumentsParse(["project", "edit", "site", "--network-visibility", "private"])

    expect(result).toEqual({
      success: true,
      data: {
        command: { kind: "project-edit", name: "site", caddy: { networkVisibility: "private" } },
        json: false,
        socket: undefined,
      },
    })
  })

  test("rejects unknown visibility values", () => {
    const result = projectRegistryCliArgumentsParse([
      "project",
      "create",
      "--name=site",
      "--network-visibility=tailnet",
    ])

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toContain("Option --network-visibility must be public or private.")
  })

  test("documents the visibility flag in help", () => {
    expect(projectRegistryCliHelp).toContain("--network-visibility <public|private>")
  })
})
