import { createResult, createResultError } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"

/**
 * Production dev process runner: spawns the command directly with Bun (argv
 * arrays only, never a shell) and captures its output. The daemon passes this
 * as the `systemd-run`/`systemctl` seam; tests inject fakes instead — real
 * systemd units are never started in tests.
 */
export function devProcessRunnerDefault(): DevProcessRunner {
  return async (command, args, input) => {
    const op = "devProcessRunner"
    try {
      const spawned = Bun.spawn([command, ...args], {
        stdin: new Blob([input]),
        stdout: "pipe",
        stderr: "pipe",
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(spawned.stdout).text(),
        new Response(spawned.stderr).text(),
        spawned.exited,
      ])
      return createResult({ exitCode, stdout, stderr })
    } catch {
      return createResultError(op, "dev process execution failed")
    }
  }
}
