import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { DevProcessRunner } from "../dev/DevProcessRunner.js"

export type ManagedServiceSystemctlOutput = { exitCode: number; stdout: string; stderr: string }

/** Run `systemctl <args>` through the injected runner; a non-zero exit is an error unless allowed. */
export async function managedServiceSystemctl(
  runner: DevProcessRunner,
  args: readonly string[],
  allowFailure = false,
): PromiseResult<ManagedServiceSystemctlOutput> {
  const op = "managedServiceSystemctl"
  let result: Awaited<ReturnType<DevProcessRunner>>
  try {
    result = await runner("systemctl", args, "")
  } catch {
    return createResultErrorCode(op, `systemctl ${args.join(" ")} failed`, "services.unavailable")
  }
  if (!result.success) return createResultErrorCode(op, `systemctl ${args.join(" ")} failed`, "services.unavailable")
  if (result.data.exitCode !== 0 && !allowFailure) {
    const detail = result.data.stderr.trim().split("\n").at(-1) ?? ""
    return createResultErrorCode(
      op,
      `systemctl ${args.join(" ")} exited ${result.data.exitCode}${detail === "" ? "" : `: ${detail}`}`,
      "services.unavailable",
    )
  }
  return createResult(result.data)
}
