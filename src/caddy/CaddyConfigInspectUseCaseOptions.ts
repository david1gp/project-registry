import type { CaddyInspectionOptions } from "./CaddyInspectionOptions.js"

export type CaddyConfigInspectUseCaseOptions = CaddyInspectionOptions & {
  configOptions?: unknown
  selector?: unknown
}
