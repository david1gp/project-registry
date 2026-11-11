import { createResultError } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"

export function devProcessRunnerDefault(): DevProcessRunner {
  return async () => createResultError("devProcessRunner", "dev process spawning is not implemented")
}
