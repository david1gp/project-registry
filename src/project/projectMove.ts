import { createResultErrorCode, type PromiseResult } from "#result"
import type { ProjectRepositoryTransaction } from "../project-store/ProjectRepositoryTransaction.js"
import type { Project } from "./Project.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import { projectCanonicalNormalize } from "./projectCanonicalNormalize.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"
import { projectTailscalePrivateRoutesValidate } from "./projectTailscalePrivateRoutesValidate.js"

export async function projectMove(
  options: ProjectUseCaseOptions,
  key: { owner: string; name: string },
  toOwner: string,
  rewrite: { from: string; to: string } | undefined,
  mutationOptions: ProjectMutationOptions,
  afterPersistence?: (previous: Project, project: Project) => void,
): PromiseResult<ProjectRepositoryTransaction> {
  const op = "projectMove"
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR
  for (const owner of [key.owner, toOwner]) {
    const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, owner)
    if (!authorizationR.success) return authorizationR
  }
  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  const revisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!revisionR.success) return revisionR
  const source = snapshotR.data.projects.find((project) => project.owner === key.owner && project.name === key.name)
  if (!source) return createResultErrorCode(op, "project not found", "projects.not-found")
  if (snapshotR.data.projects.some((project) => project.owner === toOwner && project.name === key.name)) {
    return createResultErrorCode(op, "target project already exists", "projects.conflict")
  }
  const sourceR = projectMigrate(source)
  if (!sourceR.success) return sourceR
  const labels = { ...sourceR.data.labels }
  if (rewrite && labels.sourcePath?.startsWith(rewrite.from)) {
    labels.sourcePath = rewrite.to + labels.sourcePath.slice(rewrite.from.length)
  }
  const projectR = projectCanonicalNormalize(
    { ...sourceR.data, owner: toOwner, labels },
    {
      projects: snapshotR.data.projects.filter((project) => project.owner !== key.owner || project.name !== key.name),
      portRange: options.portRange,
      defaultUserDomains: options.defaultUserDomains,
    },
  )
  if (!projectR.success) return projectR
  const tailscaleR = projectTailscalePrivateRoutesValidate(projectR.data, toOwner, op)
  if (!tailscaleR.success) return tailscaleR
  const mutationR = await options.repository.transact({
    actor: actorR.data.username,
    expectedRevision: revisionR.data,
    writes: [projectR.data],
    removals: [key],
  })
  if (!mutationR.success) return mutationR
  if (mutationR.data.changed) {
    try {
      afterPersistence?.(source, projectR.data)
    } catch {
      /* Persistence already succeeded. */
    }
  }
  return mutationR
}
