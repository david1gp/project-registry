import type { ProjectKey } from "./projectKey.js"

export type ProjectOrganizationEntry = {
  project: ProjectKey
  serviceId: string
  displayName?: string
  order: number
}
