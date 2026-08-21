import { describe, expect, test } from "bun:test"
import { projectAccessLogTimestampFormat } from "./projectAccessLogTimestampFormat.js"

describe("projectAccessLogTimestampFormat", () => {
  test("formats fractional Caddy epoch seconds as milliseconds", () => {
    const timestamp = 1_755_757_341.418

    expect(projectAccessLogTimestampFormat(timestamp)).toBe(new Date(1_755_757_341_418).toLocaleString("de-DE"))
    expect(projectAccessLogTimestampFormat(timestamp)).not.toBe(new Date(timestamp).toLocaleString("de-DE"))
  })
})
