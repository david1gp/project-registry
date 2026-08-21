import { describe, expect, test } from "bun:test"
import { projectAccessLogId } from "./projectAccessLogId.js"

describe("projectAccessLogId", () => {
  test("uses a stable SHA-256 identity for the owner/name pair", () => {
    expect(projectAccessLogId({ owner: "alice", name: "catalog" })).toBe(
      "6b6e5d563fb0eefa6a55a6b375cf7782190924b85d62d334cdec973130079e59",
    )
    expect(projectAccessLogId({ owner: "alice", name: "catalog" })).toBe(
      projectAccessLogId({ owner: "alice", name: "catalog" }),
    )
    expect(projectAccessLogId({ owner: "catalog", name: "alice" })).not.toBe(
      projectAccessLogId({ owner: "alice", name: "catalog" }),
    )
  })
})
