import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { docsLogicalPagePathResolve } from "./docsLogicalPagePath.js"

describe("docsLogicalPagePathResolve", () => {
  let originalCwd: string
  let cwd: string

  beforeEach(async () => {
    originalCwd = process.cwd()
    cwd = await mkdtemp(join(tmpdir(), "project-registry-docs-path-"))
    process.chdir(cwd)
  })

  afterEach(async () => {
    process.chdir(originalCwd)
    await rm(cwd, { recursive: true, force: true })
  })

  test("normalizes parent segments that resolve within cwd", () => {
    const result = docsLogicalPagePathResolve("docs/../guide.md")

    expect(result).toEqual({ success: true, data: "guide.md" })
  })

  test("keeps normalized hierarchy for an in-cwd relative path", () => {
    const result = docsLogicalPagePathResolve("./docs/../guide/intro.md")

    expect(result).toEqual({ success: true, data: "guide/intro.md" })
  })

  test("uses the basename for a relative source path outside cwd", () => {
    const result = docsLogicalPagePathResolve("../guide.md")

    expect(result).toEqual({ success: true, data: "guide.md" })
  })

  test("rejects the reserved index after normalization and route-unsafe characters", () => {
    expect(docsLogicalPagePathResolve("docs/../index.md").success).toBe(false)
    expect(docsLogicalPagePathResolve("bad name.md").success).toBe(false)
    expect(docsLogicalPagePathResolve("_draft.md").success).toBe(false)
    expect(docsLogicalPagePathResolve(".hidden/page.md").success).toBe(false)
    expect(docsLogicalPagePathResolve("notes..md").success).toBe(false)
  })
})
