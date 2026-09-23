import type { ProjectKey } from "./projectKey.js"
import type { ProjectOrganizationEntry } from "./ProjectOrganizationEntry.js"

export type ProjectOrganizationRequest =
  | {
      action: "merge"
      target: ProjectKey
      sources: ProjectKey[]
      targetDisplayName?: string
      entries: ProjectOrganizationEntry[]
    }
  | {
      action: "split"
      source: ProjectKey
      serviceId: string
      target: ProjectKey
      targetDisplayName?: string
    }
  | {
      action: "sectionRename"
      section: string
      displayName: string
    }
  | {
      action: "displayEdit"
      projects: {
        key: ProjectKey
        displayName?: string
        services: { id: string; displayName?: string; order: number }[]
      }[]
    }
