import { describe, expect, test } from "bun:test"
import { projectServiceDevCommandValidate } from "./projectServiceDevCommandValidate.js"

describe("projectServiceDevCommandValidate", () => {
  test("accepts a plain argv command", async () => {
    expect(projectServiceDevCommandValidate("bun run dev")).toEqual({
      success: true,
      data: ["bun", "run", "dev"],
    })
  })

  test("accepts port and host placeholders for flag-style servers", async () => {
    expect(
      projectServiceDevCommandValidate("bun run vite --mode development --host {host} --port {port} --strictPort"),
    ).toEqual({
      success: true,
      data: ["bun", "run", "vite", "--mode", "development", "--host", "{host}", "--port", "{port}", "--strictPort"],
    })
  })

  test("accepts relative executable paths and pinned values", async () => {
    const result = projectServiceDevCommandValidate(
      "bun --bun ./node_modules/vite/bin/vite.js dev --port {port} --host {host} --flag=value,other@x%y+z",
    )
    expect(result.success).toBe(true)
  })

  test("rejects blank commands", async () => {
    for (const command of ["", "   ", "\t\n "]) {
      const result = projectServiceDevCommandValidate(command)
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toBe("dev command must not be blank")
    }
  })

  test("rejects non-string commands", async () => {
    for (const command of [undefined, null, 42, ["bun", "run"]]) {
      expect(projectServiceDevCommandValidate(command).success).toBe(false)
    }
  })

  test("rejects overlong commands", async () => {
    const result = projectServiceDevCommandValidate(`bun run ${"x".repeat(512)}`)
    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.errorMessage).toBe("dev command is too long")
  })

  test("rejects shell metacharacters that would imply shell interpretation", async () => {
    for (const command of [
      "bun run dev && rm -rf /",
      "bun run dev; echo hi",
      "bun run dev | cat",
      "PORT=4400 bun run dev",
      "echo $(whoami)",
      "echo `whoami`",
      'bun run "dev script"',
      "bun run 'dev'",
      "bun run dev > out.log",
      "bun run dev < in.txt",
      "vite --open *",
      "bun run dev # comment",
      "bun run dev!",
      "bun run ~/dev",
      "bun run (dev)",
    ]) {
      const result = projectServiceDevCommandValidate(command)
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toBe("dev command must not contain shell metacharacters")
    }
  })

  test("rejects unknown placeholders and stray braces", async () => {
    for (const command of [
      "bun run vite --port {portx}",
      "bun run vite --port {foo}",
      "bun run {dev}",
      "bun run dev}",
    ]) {
      const result = projectServiceDevCommandValidate(command)
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toContain("unknown placeholder")
    }
  })

  test("rejects executable paths escaping the project directory", async () => {
    for (const command of ["/usr/bin/vite dev", "/bin/sh -c evil", "../evil/server.ts", "foo/../../evil dev"]) {
      const result = projectServiceDevCommandValidate(command)
      expect(result.success).toBe(false)
      if (result.success) continue
      expect(result.errorMessage).toBe("dev command must not escape its project directory")
    }
  })
})
