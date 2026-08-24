import { createResult, createResultError, type Result } from "#result"

type SocketResolveError = Extract<Result<never>, { success: false }> & { hint: string }

function socketResolveError(op: string, errorMessage: string, hint: string): SocketResolveError {
  return { ...createResultError(op, errorMessage), hint }
}

export function projectRegistryCliSocketResolve(
  explicitSocket: string | undefined,
  environment: Readonly<Record<string, string | undefined>>,
): Result<string> {
  const op = "projectRegistryCliSocketResolve"
  if (explicitSocket !== undefined) return createResult(explicitSocket)

  const environmentSocket = environment.PROJECT_REGISTRY_SOCKET
  if (environmentSocket !== undefined) {
    if (environmentSocket.length === 0) {
      return socketResolveError(
        op,
        "PROJECT_REGISTRY_SOCKET must not be empty.",
        "Set PROJECT_REGISTRY_SOCKET to a Unix socket path or pass --socket <path>.",
      )
    }
    return createResult(environmentSocket)
  }

  const username = environment.USER
  if (username === undefined || username.length === 0)
    return socketResolveError(
      op,
      "USER is required to select the default project-registry socket.",
      "Set USER or pass --socket <path>.",
    )
  if (username.length > 32 || !/^[A-Za-z_][A-Za-z0-9_.-]*\$?$/.test(username))
    return socketResolveError(
      op,
      "USER is not safe for a project-registry socket path.",
      "Use a valid Unix username in USER or pass --socket <path>.",
    )
  return createResult(`/run/project-registry/${username}.sock`)
}
