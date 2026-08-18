import type { CaddyProcessRunner } from "./CaddyProcessRunner.js"
import type { CaddyTimer } from "./CaddyTimer.js"

export type CaddyConfigValidateOptions = {
  caddyBin?: string
  processRunner?: CaddyProcessRunner
  timeoutMs?: number
  signal?: AbortSignal
  timer?: CaddyTimer
}
