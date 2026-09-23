import { createResult, createResultErrorCode, type PromiseResult } from "#result"
import type { ProjectRepositoryTransaction } from "../project-store/ProjectRepositoryTransaction.js"
import type { ProjectOrganizationRequest } from "./ProjectOrganizationRequest.js"
import type { Project } from "./Project.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import { projectKeyEqual } from "./projectKeyEqual.js"
import { projectMigrate } from "./projectMigrate.js"
import { projectMutationExpectedRevision } from "./projectMutationExpectedRevision.js"
import { projectOwnerAuthorize } from "./projectOwnerAuthorize.js"
import type { ProjectCanonical } from "./projectCanonicalSchema.js"

function keyText(key: { owner: string; name: string }): string {
  return `${key.owner}\u0000${key.name}`
}

function projectKeyValid(key: unknown): key is { owner: string; name: string } {
  return (
    key !== null &&
    typeof key === "object" &&
    !Array.isArray(key) &&
    typeof (key as Record<string, unknown>).owner === "string" &&
    typeof (key as Record<string, unknown>).name === "string"
  )
}

function requestValid(request: unknown): request is ProjectOrganizationRequest {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return false
  const input = request as Record<string, unknown>
  if (input.action === "merge") {
    if (!projectKeyValid(input.target) || !Array.isArray(input.sources) || !input.sources.every(projectKeyValid))
      return false
    if (!Array.isArray(input.entries)) return false
    return input.entries.every((entry) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false
      const value = entry as Record<string, unknown>
      return projectKeyValid(value.project) && typeof value.serviceId === "string" && typeof value.order === "number"
    })
  }
  if (input.action === "split") {
    return projectKeyValid(input.source) && typeof input.serviceId === "string" && projectKeyValid(input.target)
  }
  if (input.action === "sectionRename")
    return typeof input.section === "string" && typeof input.displayName === "string"
  return (
    input.action === "displayEdit" &&
    Array.isArray(input.projects) &&
    input.projects.every((project) => {
      if (project === null || typeof project !== "object" || Array.isArray(project)) return false
      const value = project as Record<string, unknown>
      return (
        projectKeyValid(value.key) &&
        (value.displayName === undefined || typeof value.displayName === "string") &&
        Array.isArray(value.services) &&
        value.services.every((service) => {
          if (service === null || typeof service !== "object" || Array.isArray(service)) return false
          const entry = service as Record<string, unknown>
          return (
            typeof entry.id === "string" &&
            entry.id.length > 0 &&
            typeof entry.order === "number" &&
            (entry.displayName === undefined || typeof entry.displayName === "string")
          )
        })
      )
    })
  )
}

function sectionKey(project: ProjectCanonical): string {
  const section = project.labels.section?.trim().toLowerCase()
  return section || "fallback"
}

function sectionMatches(project: ProjectCanonical, section: string): boolean {
  const normalized = section.trim().toLowerCase()
  return (normalized || "fallback") === sectionKey(project)
}

function serviceUniqueId(sourceName: string, serviceId: string, used: Set<string>): string {
  if (!used.has(serviceId)) return serviceId
  const base = `${sourceName}-${serviceId}`
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
  let candidate = base.slice(0, 63) || "service"
  let suffix = 2
  while (used.has(candidate)) {
    const ending = `-${suffix}`
    candidate = `${base.slice(0, 63 - ending.length)}${ending}`
    suffix += 1
  }
  return candidate
}

function organizationMerge(
  projects: ProjectCanonical[],
  request: Extract<ProjectOrganizationRequest, { action: "merge" }>,
): { writes: ProjectCanonical[]; removals: Project[] } | undefined {
  const target = projects.find((project) => projectKeyEqual(project, request.target))
  if (!target || request.sources.length === 0) return undefined
  const sourceKeys = new Set(request.sources.map(keyText))
  if (sourceKeys.size !== request.sources.length || sourceKeys.has(keyText(request.target))) return undefined
  const sources = request.sources.map((key) => projects.find((project) => projectKeyEqual(project, key)))
  if (sources.some((project) => project === undefined)) return undefined
  const all = [target, ...(sources as ProjectCanonical[])]
  if (all.some((project) => project.owner !== target.owner)) return undefined
  if ((sources as ProjectCanonical[]).some((project) => project.services.length === 0)) return undefined

  const original = [
    target,
    ...(sources as ProjectCanonical[]).sort((left, right) => keyText(left).localeCompare(keyText(right))),
  ].flatMap((project) => project.services.map((service) => ({ project, service })))
  if (request.entries.length !== original.length) return undefined
  const refs = new Set<string>()
  for (const entry of request.entries) {
    const ref = `${keyText(entry.project)}\u0000${entry.serviceId}`
    if (refs.has(ref) || !Number.isFinite(entry.order) || entry.order < 0) return undefined
    refs.add(ref)
  }
  if (original.some(({ project, service }) => !refs.has(`${keyText(project)}\u0000${service.id}`))) return undefined
  const used = new Set(target.services.map((service) => service.id))
  const idsByReference = new Map<string, string>()
  for (const { project, service } of original) {
    const reference = `${keyText(project)}\u0000${service.id}`
    if (project === target) {
      idsByReference.set(reference, service.id)
      continue
    }
    const id = serviceUniqueId(project.name, service.id, used)
    used.add(id)
    idsByReference.set(reference, id)
  }
  const services = request.entries.map((entry) => {
    const project = all.find((candidate) => projectKeyEqual(candidate, entry.project))
    const originalService = project?.services.find((service) => service.id === entry.serviceId)
    if (!project || !originalService) return undefined
    const id = idsByReference.get(`${keyText(project)}\u0000${originalService.id}`)
    if (id === undefined) return undefined
    return {
      ...originalService,
      id,
      order: entry.order,
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
    }
  })
  if (services.some((service) => service === undefined)) return undefined
  const merged = {
    ...target,
    ...Object.fromEntries(
      (
        [
          "displayName",
          "description",
          "github",
          "previewUrl",
          "previewPort",
          "productionUrl",
          "productionAssetsUrl",
        ] as const
      )
        .filter((field) => target[field] === undefined)
        .map((field) => [field, (sources as ProjectCanonical[]).find((source) => source[field] !== undefined)?.[field]])
        .filter(([, value]) => value !== undefined),
    ),
    ...(request.targetDisplayName === undefined ? {} : { displayName: request.targetDisplayName }),
    labels: Object.assign({}, ...[...(sources as ProjectCanonical[]), target].map((source) => source.labels)),
    services: services as NonNullable<(typeof services)[number]>[],
  }
  return { writes: [merged], removals: sources as Project[] }
}

function organizationDisplayEdit(
  projects: ProjectCanonical[],
  request: Extract<ProjectOrganizationRequest, { action: "displayEdit" }>,
): ProjectCanonical[] | undefined {
  if (request.projects.length === 0) return undefined
  const projectKeys = new Set<string>()
  const writes: ProjectCanonical[] = []
  for (const entry of request.projects) {
    const key = keyText(entry.key)
    if (projectKeys.has(key)) return undefined
    projectKeys.add(key)
    const project = projects.find((candidate) => projectKeyEqual(candidate, entry.key))
    if (!project) return undefined
    const serviceIds = new Set<string>()
    if (entry.services.length !== project.services.length) return undefined
    const services = entry.services.map((service) => {
      if (serviceIds.has(service.id) || !Number.isFinite(service.order) || service.order < 0) return undefined
      serviceIds.add(service.id)
      const original = project.services.find((candidate) => candidate.id === service.id)
      if (!original) return undefined
      return {
        ...original,
        order: service.order,
        ...(service.displayName === undefined ? {} : { displayName: service.displayName }),
      }
    })
    if (services.some((service) => service === undefined)) return undefined
    writes.push({
      ...project,
      ...(entry.displayName === undefined ? {} : { displayName: entry.displayName }),
      services: services as ProjectCanonical["services"],
    })
  }
  return writes
}

export async function projectOrganize(
  options: ProjectUseCaseOptions,
  request: ProjectOrganizationRequest,
  mutationOptions: ProjectMutationOptions,
  ownerScope?: string,
): PromiseResult<ProjectRepositoryTransaction> {
  const op = "projectOrganize"
  if (!requestValid(request)) return createResultErrorCode(op, "organization request is invalid", "request.invalid")
  if (ownerScope !== undefined) {
    const keys =
      request.action === "merge"
        ? [request.target, ...request.sources, ...request.entries.map(({ project }) => project)]
        : request.action === "split"
          ? [request.source, request.target]
          : request.action === "displayEdit"
            ? request.projects.map(({ key }) => key)
            : []
    if (keys.some((key) => key.owner !== ownerScope)) {
      return createResultErrorCode(op, "organization project owner does not match the route owner", "request.invalid")
    }
  }
  const actorR = await options.access.actorResolve()
  if (!actorR.success) return actorR
  const snapshotR = await options.repository.read()
  if (!snapshotR.success) return snapshotR
  const revisionR = projectMutationExpectedRevision(mutationOptions, snapshotR.data.revision, op)
  if (!revisionR.success) return revisionR

  const parsedProjects: ProjectCanonical[] = []
  for (const project of snapshotR.data.projects) {
    const projectR = projectMigrate(project)
    if (!projectR.success) return projectR
    parsedProjects.push(projectR.data)
  }

  let owners: string[]
  let writes: ProjectCanonical[]
  let removals: Project[]
  if (request.action === "merge") {
    owners = [request.target.owner, ...request.sources.map(({ owner }) => owner)]
    const merged = organizationMerge(parsedProjects, request)
    if (!merged) return createResultErrorCode(op, "merge entries, sources, or target are invalid", "request.invalid")
    writes = merged.writes
    removals = merged.removals
  } else if (request.action === "split") {
    owners = [request.source.owner]
    if (request.target.owner !== request.source.owner || projectKeyEqual(request.target, request.source)) {
      return createResultErrorCode(
        op,
        "split target must be a distinct project owned by the same owner",
        "request.invalid",
      )
    }
    const source = parsedProjects.find((project) => projectKeyEqual(project, request.source))
    if (!source) return createResultErrorCode(op, "split source not found", "projects.not-found")
    if (parsedProjects.some((project) => projectKeyEqual(project, request.target))) {
      return createResultErrorCode(op, "split target already exists", "projects.conflict")
    }
    const service = source.services.find((entry) => entry.id === request.serviceId)
    if (!service) return createResultErrorCode(op, "split service not found", "projects.not-found")
    writes = [
      { ...source, services: source.services.filter((entry) => entry.id !== service.id) },
      {
        schemaVersion: 2,
        owner: request.target.owner,
        name: request.target.name,
        order: Number.MAX_SAFE_INTEGER,
        ...(request.targetDisplayName === undefined ? {} : { displayName: request.targetDisplayName }),
        labels: { ...(source.labels.section ? { section: source.labels.section } : {}) },
        services: [service],
      },
    ]
    removals = []
  } else if (request.action === "sectionRename") {
    const normalizedSection = request.section.trim().toLowerCase() || "fallback"
    owners = parsedProjects
      .filter(
        (project) =>
          (ownerScope === undefined || project.owner === ownerScope) && sectionMatches(project, normalizedSection),
      )
      .map(({ owner }) => owner)
    if (!request.displayName.trim())
      return createResultErrorCode(op, "section display name must not be empty", "request.invalid")
    const affected = parsedProjects.filter(
      (project) =>
        (ownerScope === undefined || project.owner === ownerScope) && sectionMatches(project, normalizedSection),
    )
    writes = affected.map((project) => ({
      ...project,
      labels: { ...project.labels, section: request.displayName.trim() },
    }))
    removals = []
  } else {
    const edited = organizationDisplayEdit(parsedProjects, request)
    if (!edited)
      return createResultErrorCode(op, "display edits must include every service exactly once", "request.invalid")
    owners = edited.map(({ owner }) => owner)
    writes = edited
    removals = []
  }

  for (const owner of [...new Set(owners)]) {
    const authorizationR = await projectOwnerAuthorize(options.access, actorR.data, owner)
    if (!authorizationR.success) return authorizationR
  }
  if (writes.length === 0 && removals.length === 0)
    return createResultErrorCode(op, "no projects matched the operation", "request.invalid")
  const mutationR = await options.repository.transact({
    actor: actorR.data.username,
    expectedRevision: revisionR.data,
    writes,
    removals: removals.map(({ owner, name }) => ({ owner, name })),
  })
  return mutationR
}
