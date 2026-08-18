import type { PromiseResult } from "#result"
import type { CaddyProcessRunOptions } from "./CaddyProcessRunOptions.js"

export type CaddyProcessRunner = (
  command: string,
  args: readonly string[],
  input: string,
  options?: CaddyProcessRunOptions,
) => PromiseResult<{
  exitCode: number
  stdout: string
  stderr: string
}>
