import { describe, expect, test } from "bun:test"
import { projectAccessLogCursorCreate } from "./projectAccessLogCursor.js"

const input = {
  anchorDigest: "b".repeat(64),
  projectId: "a".repeat(64),
  source: "access.jsonl",
  sourceFingerprint: "active:1:2",
  line: 7,
}

describe("projectAccessLogCursorCreate", () => {
  test("signs and decodes a versioned opaque cursor", () => {
    const cursor = projectAccessLogCursorCreate({ secret: "test-secret", clock: () => 1_000 })
    const encoded = cursor.encode(input)
    expect(encoded.success).toBe(true)
    if (!encoded.success) return
    expect(encoded.data).toMatch(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)
    expect(encoded.data).not.toContain(input.projectId)
    expect(cursor.decode(encoded.data)).toEqual({
      success: true,
      data: { ...input, version: 1, expiresAt: 901_000 },
    })
  })

  test("signs and decodes an optional absolute source offset", () => {
    const cursor = projectAccessLogCursorCreate({ secret: "test-secret", clock: () => 1_000 })
    const encoded = cursor.encode({ ...input, offset: 1234 })
    expect(encoded.success).toBe(true)
    if (!encoded.success) return
    expect(cursor.decode(encoded.data)).toMatchObject({ success: true, data: { offset: 1234 } })
  })

  test("rejects tampering, old versions, and expired cursors", () => {
    let now = 1_000
    const cursor = projectAccessLogCursorCreate({ secret: "test-secret", clock: () => now, lifetimeMs: 100 })
    const encoded = cursor.encode(input)
    expect(encoded.success).toBe(true)
    if (!encoded.success) return
    expect(cursor.decode(`${encoded.data}x`)).toMatchObject({ success: false, code: "access-log.invalid-cursor" })
    expect(cursor.decode(encoded.data.replace("v1.", "v2."))).toMatchObject({
      success: false,
      code: "access-log.invalid-cursor",
    })
    now = 1_100
    expect(cursor.decode(encoded.data)).toMatchObject({ success: false, code: "access-log.cursor-expired" })
  })
})
