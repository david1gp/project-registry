import { createResult, createResultError, type Result } from "#result"

export const projectServiceEnvFileMaxLength = 255

const envFilePattern = /^[A-Za-z0-9_.-][A-Za-z0-9_./-]*$/

/**
 * Validate a managed-service env file path: relative to the project
 * directory, plain path characters only, no `..`/`.` segments or empty
 * segments. Symlink escapes are checked again when the daemon reads the file.
 */
export function projectServiceEnvFileValidate(envFile: unknown): Result<string> {
  const op = "projectServiceEnvFileValidate"
  if (typeof envFile !== "string" || envFile === "") return createResultError(op, "env file must not be blank")
  if (envFile.length > projectServiceEnvFileMaxLength) return createResultError(op, "env file path is too long")
  if (!envFilePattern.test(envFile)) {
    return createResultError(op, "env file must be a relative path inside the project directory")
  }
  const segments = envFile.split("/")
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    return createResultError(op, "env file must be a relative path inside the project directory")
  }
  return createResult(envFile)
}
