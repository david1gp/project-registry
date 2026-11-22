import { describe, expect, test } from "bun:test"
import { createServer } from "node:net"
import { createResult } from "#result"
import { devListeningSockets } from "./devListeningSockets.js"
import { devPortAllocate } from "./devPortAllocate.js"

describe("devListeningSockets", () => {
  test("detects a real loopback listener and prevents its allocation", async () => {
    const server = createServer()
    await new Promise<void>((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve))
    try {
      const address = server.address()
      if (address === null || typeof address === "string") throw new Error("no TCP address")
      const result = await devListeningSockets(async (command, args) => {
        const child = Bun.spawn([command, ...args], { stdout: "pipe", stderr: "pipe" })
        return createResult({ exitCode: await child.exited, stdout: await new Response(child.stdout).text(), stderr: await new Response(child.stderr).text() })
      })
      expect(result.success).toBe(true)
      if (!result.success) return
      expect(result.data.some((socket) => socket.port === address.port)).toBe(true)
      const allocated = devPortAllocate([], [], { from: address.port, to: address.port }, result.data.map((socket) => socket.port))
      expect(allocated.success).toBe(false)
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
