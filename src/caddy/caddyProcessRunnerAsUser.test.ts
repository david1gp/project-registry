import { describe, expect, spyOn, test } from "bun:test"
import { createResult } from "#result"
import { caddyProcessRunnerAsUser } from "./caddyProcessRunnerAsUser.js"

describe("caddyProcessRunnerAsUser", () => {
  test("forwards the runuser command, arguments, stdin, and execution options unchanged", async () => {
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("out"))
        controller.close()
      },
    })
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("err"))
        controller.close()
      },
    })
    let resolveExit!: (exitCode: number) => void
    const exited = new Promise<number>((resolve) => {
      resolveExit = resolve
    })
    const spawn = spyOn(Bun, "spawn").mockReturnValue({
      stdout,
      stderr,
      exited,
      kill: () => undefined,
    } as unknown as ReturnType<typeof Bun.spawn>)

    try {
      const signal = new AbortController().signal
      const run = caddyProcessRunnerAsUser("root", "root")
      const resultPromise = run(
        "/usr/local/libexec/project-registry-caddy",
        ["validate", "--config", "-"],
        "config-json",
        {
          timeoutMs: 1234,
          signal,
        },
      )

      expect(spawn).toHaveBeenCalledTimes(1)
      const [command, options] = spawn.mock.calls[0]!
      const spawnOptions = options!
      expect(command).toEqual([
        "/usr/sbin/runuser",
        "-u",
        "root",
        "-g",
        "root",
        "--",
        "/usr/local/libexec/project-registry-caddy",
        "validate",
        "--config",
        "-",
      ])
      expect(await new Response(spawnOptions.stdin as BodyInit).text()).toBe("config-json")
      expect(spawnOptions.signal).toBeInstanceOf(AbortSignal)
      expect(spawnOptions.killSignal).toBe("SIGKILL")
      let settled = false
      void resultPromise.then(() => {
        settled = true
      })
      await Promise.resolve()
      expect(settled).toBe(false)
      resolveExit(0)
      const result = await resultPromise
      expect(result).toEqual(createResult({ exitCode: 0, stdout: "out", stderr: "err" }))
    } finally {
      spawn.mockRestore()
    }
  })
})
