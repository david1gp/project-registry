import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import { projectAuthorize } from "../access/projectAuthorize.js"
import type { Role } from "../access/Role.js"
import type { Project } from "./Project.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"
import { projectList } from "./projectList.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"
import { projectRevisionValidate } from "./projectRevisionValidate.js"

type ProjectListInput = {
  owner?: string
}

function projectListCanonicalize(projects: readonly Project[]): Result<ProjectCanonical[]> {
  const canonical: ProjectCanonical[] = []
  for (const project of projects) {
    const projectR = projectMigrate(project)
    if (!projectR.success) return projectR
    canonical.push(projectR.data)
  }
  return createResult(canonical)
}

export async function projectListUseCase(
  options: ProjectUseCaseOptions,
  input: ProjectListInput | string = {},
): PromiseResult<{ projects: ProjectCanonical[]; revision: string }> {
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR
  const actor = actorR.data
  const rawOwner =
    typeof input === "string"
      ? input
      : input && typeof input === "object" && !Array.isArray(input)
        ? (input as ProjectListInput).owner
        : undefined
  if (rawOwner !== undefined && typeof rawOwner !== "string") {
    return createResultError("projectListUseCase", "project owner is invalid")
  }
  const owner = rawOwner === undefined ? undefined : rawOwner.trim()

  if (owner !== undefined) {
    const authorizationR = await projectOwnerAuthorize(options.access, actor, owner)
    if (!authorizationR.success) return authorizationR

    const snapshotR = await options.repository.read()
    if (!snapshotR.success) return snapshotR
    const revisionR = projectRevisionValidate(snapshotR.data.revision, "projectListUseCase")
    if (!revisionR.success) return revisionR
    const listR = projectList(snapshotR.data.projects.filter((project) => project.owner === owner))
    if (!listR.success) return listR
    const projectsR = projectListCanonicalize(listR.data)
    if (!projectsR.success) return projectsR
    return createResult({ projects: projectsR.data, revision: revisionR.data })
  }

  const actorOwnerRoleR = await options.access.ownerRoleResolve(actor.username)
  if (!actorOwnerRoleR.success) return actorOwnerRoleR
  const actorAuthorizationR = projectAuthorize(actor, actor.username, actorOwnerRoleR.data)
  if (!actorAuthorizationR.success) return actorAuthorizationR

  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  const revisionR = projectRevisionValidate(snapshotR.data.revision, "projectListUseCase")
  if (!revisionR.success) return revisionR

  const ownerRoles = new Map<string, Role | undefined>([[actor.username, actorOwnerRoleR.data]])
  const visibleProjects: Project[] = []
  for (const project of snapshotR.data.projects) {
    let ownerRole = ownerRoles.get(project.owner)
    if (!ownerRoles.has(project.owner)) {
      const ownerRoleR = await options.access.ownerRoleResolve(project.owner)
      if (!ownerRoleR.success) return ownerRoleR
      ownerRole = ownerRoleR.data
      ownerRoles.set(project.owner, ownerRole)
    }

    const authorizationR = projectAuthorize(actor, project.owner, ownerRole)
    if (authorizationR.success) {
      visibleProjects.push(project)
      continue
    }
    if (ownerRole !== undefined && !["own", "admin", "superadmin"].includes(ownerRole)) return authorizationR
    if (ownerRole === undefined && actor.role !== "superadmin") continue
    if (actor.role === "admin" && ownerRole === "superadmin") continue
    if (actor.role === "own" && (ownerRole !== "own" || project.owner !== actor.username)) continue
    return authorizationR
  }

  const listR = projectList(visibleProjects)
  if (!listR.success) return listR
  const projectsR = projectListCanonicalize(listR.data)
  if (!projectsR.success) return projectsR
  return createResult({ projects: projectsR.data, revision: revisionR.data })
}
