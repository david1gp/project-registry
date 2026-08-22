import { describe, expect, test } from "bun:test"
import { projectAccessLogCursorCreate } from "./projectAccessLogCursor.js"

const input = {
  anchorDigest: "b".repeat(64),
  projectId: "a".repeat(64),
  source: "access.jsonl",
  sourceFingerprint: "active:1:2",
  line: 7,
}

function cursorBodyEncode(body: unknown): string {
  return `v2.${Buffer.from(JSON.stringify(body), "utf8").toString("base64url")}`
}

describe("projectAccessLogCursorCreate", () => {
  test("encodes and decodes a versioned opaque cursor", () => {
    const cursor = projectAccessLogCursorCreate({ clock: () => 1_000 })
    const encoded = cursor.encode(input)
    expect(encoded.success).toBe(true)
    if (!encoded.success) return
    expect(encoded.data).toMatch(/^v2\.[A-Za-z0-9_-]+$/)
    expect(encoded.data).not.toContain(input.projectId)
    expect(cursor.decode(encoded.data)).toEqual({
      success: true,
      data: { ...input, version: 2, expiresAt: 901_000 },
    })
  })

  test("encodes and decodes an optional absolute source offset", () => {
    const cursor = projectAccessLogCursorCreate({ clock: () => 1_000 })
    const encoded = cursor.encode({ ...input, offset: 1234 })
    expect(encoded.success).toBe(true)
    if (!encoded.success) return
    expect(cursor.decode(encoded.data)).toMatchObject({ success: true, data: { offset: 1234 } })
  })

  test("rejects malformed cursors, old versions, and expired cursors", () => {
    let now = 1_000
    const cursor = projectAccessLogCursorCreate({ clock: () => now, lifetimeMs: 100 })
    const encoded = cursor.encode(input)
    expect(encoded.success).toBe(true)
    if (!encoded.success) return
    expect(cursor.decode(`${encoded.data}.invalid`)).toMatchObject({
      success: false,
      code: "access-log.invalid-cursor",
    })
    expect(cursor.decode(encoded.data.replace("v2.", "v1."))).toMatchObject({
      success: false,
      code: "access-log.invalid-cursor",
    })
    now = 1_100
    expect(cursor.decode(encoded.data)).toMatchObject({ success: false, code: "access-log.cursor-expired" })
  })

  test("strictly validates unsigned cursor bodies", () => {
    const cursor = projectAccessLogCursorCreate({ clock: () => 1_000 })
    expect(
      cursor.decode(
        cursorBodyEncode({
          v: 2,
          a: input.anchorDigest,
          e: 901_000,
          f: input.sourceFingerprint,
          l: input.line,
          p: input.projectId,
          s: "../access.jsonl",
        }),
      ),
    ).toMatchObject({ success: false, code: "access-log.invalid-cursor" })
    expect(cursor.decode(`v2.${"a".repeat(4_094)}`)).toMatchObject({
      success: false,
      code: "access-log.invalid-cursor",
    })
  })
})
