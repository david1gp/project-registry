import { createResult, createResultError, type Result } from "#result"
import type { ManagedServiceContainerSpec } from "./ManagedServiceContainerSpec.js"

export type ManagedServiceContainerArgv = {
  start: string[]
  stop: string[]
  stopPost: string[]
}

const containerNamePattern = /^[a-z0-9][a-z0-9_.-]*$/
const stopTimeoutSeconds = "30"

// The unit owns the container lifecycle: these options are injected after
// `run`, so a row may not set them (podman lets a later flag override an
// earlier one, which would break ExecStop or the readiness handshake). The
// check is token-exact (`--name`, `--name=…`) and also covers arguments after
// the image, so a container entrypoint flag with the same spelling is refused.
const reservedRunOptions = [
  "--name",
  "--replace",
  "--rm",
  "--detach",
  "-d",
  "--cgroups",
  "--sdnotify",
  "--log-driver",
  "--umask",
  "--root",
  "--runroot",
  "--pod",
]

function commandIsPodman(command: string): boolean {
  return command === "podman" || command.endsWith("/podman")
}

/**
 * Turn a row's `podman run …` argv into the unit's ExecStart/ExecStop/
 * ExecStopPost argv (without the executable). Quadlet-style: `--replace` and
 * `--rm` clear a leftover container, `--cgroups=split` keeps conmon and the
 * payload inside the unit's delegated cgroup, `--sdnotify=conmon` makes the
 * unit active only once the container runs, and passthrough logging sends
 * stdout/stderr to the unit journal (`svc logs`). Pure.
 */
export function managedServiceContainerArgvRender(options: {
  command: string
  args: readonly string[]
  container: ManagedServiceContainerSpec
}): Result<ManagedServiceContainerArgv> {
  const op = "managedServiceContainerArgvRender"
  const { command, args, container } = options
  if (container.engine !== "podman") return createResultError(op, "container engine is not supported")
  if (!commandIsPodman(command) || args[0] !== "run") {
    return createResultError(op, "container service command must be 'podman run …'")
  }
  if (!containerNamePattern.test(container.name)) return createResultError(op, "container name is invalid")
  if (!Number.isInteger(container.userId) || container.userId < 0) {
    return createResultError(op, "container user id is invalid")
  }
  const runArgs = args.slice(1)
  if (runArgs.length === 0) return createResultError(op, "container service command needs an image")
  const reserved = runArgs.find((arg) =>
    reservedRunOptions.some((option) => arg === option || arg.startsWith(`${option}=`)),
  )
  if (reserved !== undefined) {
    return createResultError(
      op,
      `container service command must not set ${reserved.split("=")[0]}; the unit manages it`,
    )
  }
  const global = ["--root", container.storageRoot, "--runroot", `${container.runtimeDirectory}/containers`]
  return createResult({
    start: [
      ...global,
      "run",
      "--rm",
      "--replace",
      "--name",
      container.name,
      "--cgroups=split",
      "--sdnotify=conmon",
      "--detach",
      "--log-driver=passthrough",
      "--umask=0002",
      ...runArgs,
    ],
    stop: [...global, "stop", "--ignore", "--time", stopTimeoutSeconds, container.name],
    stopPost: [...global, "rm", "--force", "--ignore", container.name],
  })
}
