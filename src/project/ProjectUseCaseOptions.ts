import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectPortRange } from "./projectPortNext.js"

export type ProjectUseCaseOptions = {
  repository: ProjectRepository
  access: ProjectAccess
  portRange?: ProjectPortRange
  defaultUserDomains?: Readonly<Record<string, string>>
}
