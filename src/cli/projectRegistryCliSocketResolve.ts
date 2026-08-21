import { createResult, createResultError, type Result } from "#result"

export function projectRegistryCliSocketResolve(
  explicitSocket: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Result<string> {
  const op = "projectRegistryCliSocketResolve"
  if (explicitSocket !== undefined) return createResult(explicitSocket)

  const environmentSocket = environment.PROJECT_REGISTRY_SOCKET
  if (environmentSocket !== undefined) {
    if (environmentSocket.length === 0) return createResultError(op, "PROJECT_REGISTRY_SOCKET must not be empty.")
    return createResult(environmentSocket)
  }

  const username = environment.USER
  if (username === undefined || username.length === 0) {
    return createResultError(op, "USER is required to select the default project-registry socket.")
  }
  if (username.length > 32 || !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(username)) {
    return createResultError(op, "USER is not safe for a project-registry socket path.")
  }
  return createResult(`/run/project-registry/${username}.sock`)
}
