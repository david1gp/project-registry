import { createResult, createResultError, type Result } from "#result"

const unitUserPattern = /^[A-Za-z_][A-Za-z0-9_.-]*\$?$/
const unitProjectPattern = /^[a-z0-9][a-z0-9-]*$/
const unitServicePattern = /^[a-z0-9][a-z0-9-]*$/

export function devUnitName(options: { user: string; project: string; serviceId?: string }): Result<string> {
  const op = "devUnitName"
  if (typeof options !== "object" || options === null) return createResultError(op, "dev unit options are required")
  if (typeof options.user !== "string" || !unitUserPattern.test(options.user)) {
    return createResultError(op, "dev unit user is invalid")
  }
  if (typeof options.project !== "string" || !unitProjectPattern.test(options.project)) {
    return createResultError(op, "dev unit project is invalid")
  }
  if (options.serviceId !== undefined) {
    if (typeof options.serviceId !== "string" || !unitServicePattern.test(options.serviceId)) {
      return createResultError(op, "dev unit service is invalid")
    }
    return createResult(`dev-${options.user}-${options.project}--${options.serviceId}.service`)
  }
  return createResult(`dev-${options.user}-${options.project}.service`)
}
