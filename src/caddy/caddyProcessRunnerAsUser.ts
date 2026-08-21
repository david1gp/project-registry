import type { CaddyProcessRunOptions } from "./CaddyProcessRunOptions.js"
import type { CaddyProcessRunner } from "./CaddyProcessRunner.js"
import { caddyProcessRun } from "./caddyProcessRun.js"

export function caddyProcessRunnerAsUser(user: string, group: string): CaddyProcessRunner {
  return (command, args, input, options) =>
    caddyProcessRun(
      "/usr/sbin/runuser",
      ["-u", user, "-g", group, "--", command, ...args],
      input,
      options as CaddyProcessRunOptions | undefined,
    )
}
