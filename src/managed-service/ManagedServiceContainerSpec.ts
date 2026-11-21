import type { ProjectServiceManagedContainer } from "../project/projectServiceManagedContainers.js"

/**
 * Rootless container settings for one managed unit. `runtimeDirectory` is the
 * service user's `/run/user/<uid>` (podman runroot, pause process, netns);
 * `storageRoot` is its image/container store. Both are passed explicitly so
 * podman never guesses from the root-owned system defaults.
 */
export type ManagedServiceContainerSpec = {
  engine: ProjectServiceManagedContainer
  /** Container name; also the target of ExecStop/ExecStopPost. */
  name: string
  userId: number
  runtimeDirectory: string
  storageRoot: string
}
