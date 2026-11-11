import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { DevProcessRunner } from "./DevProcessRunner.js"

export type DevUnitStartSpec = {
  unit: string
  user: string
  uid: number
  workingDirectory: string
  port: number
  hostname: string
  pathValue: string
  command: string
  args: readonly string[]
}

function specIsValid(spec: DevUnitStartSpec): boolean {
  return (
    typeof spec.unit === "string" &&
    spec.unit.length > 0 &&
    typeof spec.user === "string" &&
    spec.user.length > 0 &&
    Number.isSafeInteger(spec.uid) &&
    spec.uid >= 0 &&
    typeof spec.workingDirectory === "string" &&
    spec.workingDirectory.startsWith("/") &&
    Number.isInteger(spec.port) &&
    spec.port >= 1 &&
    spec.port <= 65535 &&
    typeof spec.hostname === "string" &&
    spec.hostname.length > 0 &&
    typeof spec.pathValue === "string" &&
    spec.pathValue.length > 0 &&
    typeof spec.command === "string" &&
    spec.command.length > 0 &&
    Array.isArray(spec.args) &&
    spec.args.every((entry) => typeof entry === "string")
  )
}

/**
 * Start a dev server as a daemon-root transient SYSTEM unit. The unit runs as
 * `User=<user>` inside `Slice=user-<uid>.slice` (the requesting user's slice,
 * so per-user slice caps apply and the process never runs as root), with a
 * minimal allowlisted environment: the daemon environment is never inherited
 * wholesale (it holds credential paths). The served command must bind the
 * allocated loopback port via PORT; HOST pins loopback and DEV_URL carries
 * the public hostname for e2e use. Argv arrays only, never shell strings.
 */
export function devUnitStart(options: {
  runner: DevProcessRunner
  spec: DevUnitStartSpec
}): PromiseResult<{ unit: string }> {
  const op = "devUnitStart"
  if (typeof options !== "object" || options === null) {
    return Promise.resolve(createResultErrorCode(op, "dev unit start options are required", "caddy.unavailable"))
  }
  if (typeof options.runner !== "function" || !specIsValid(options.spec)) {
    return Promise.resolve(createResultErrorCode(op, "dev unit start options are invalid", "caddy.unavailable"))
  }
  return startInternal(options.runner, options.spec, op)
}

async function startInternal(
  runner: DevProcessRunner,
  spec: DevUnitStartSpec,
  op: string,
): PromiseResult<{ unit: string }> {
  const args = [
    `--unit=${spec.unit}`,
    `--property=User=${spec.user}`,
    `--property=Slice=user-${spec.uid}.slice`,
    `--property=Description=project-registry dev ${spec.user}/${spec.unit}`,
    `--working-directory=${spec.workingDirectory}`,
    `--setenv=PATH=${spec.pathValue}`,
    `--setenv=HOME=/home/${spec.user}`,
    `--setenv=PORT=${spec.port}`,
    "--setenv=HOST=127.0.0.1",
    `--setenv=DEV_URL=https://${spec.hostname}`,
    "--collect",
    "--",
    spec.command,
    ...spec.args,
  ]
  let result: Awaited<ReturnType<DevProcessRunner>>
  try {
    result = await runner("systemd-run", args, "")
  } catch {
    return createResultErrorCode(op, `dev unit ${spec.unit} could not be started`, "caddy.unavailable")
  }
  if (!result.success) return result
  if (result.data.exitCode !== 0) {
    return createResultErrorCode(op, `dev unit ${spec.unit} could not be started`, "caddy.unavailable")
  }
  return createResult({ unit: spec.unit })
}
