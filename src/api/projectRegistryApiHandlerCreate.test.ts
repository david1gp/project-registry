import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import type { GitStoreCommitInfo } from "#git-store"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import { caddyAccessLogFixture } from "../../test/fixtures/caddyAccessLogFixture.js"
import { caddyConfigGenerateFixtures } from "../../test/fixtures/caddyConfigGenerateFixtures.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { Role } from "../access/Role.js"
import type {
  ProjectAccessLogPage,
  ProjectAccessLogReadOptions,
  ProjectAccessLogSource,
} from "../access-log/ProjectAccessLogSource.js"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { Project } from "../project/Project.js"
import type { ProjectKey } from "../project/projectKey.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import { projectRepositoryOpen } from "../project-store/projectRepositoryOpen.js"
import type { ProjectRegistryDaemonRequestContext } from "../runtime/ProjectRegistryDaemonRequestContext.js"
import { projectRegistryApiHandlerCreate as projectRegistryApiHandlerCreateProduction } from "./projectRegistryApiHandlerCreate.js"

const revision = "a".repeat(40)
const nextRevision = "b".repeat(40)
const temporaryDirectories: string[] = []

type RepositoryFake = ProjectRepository & {
  historyKeys: ProjectKey[]
  ownerHistoryCalls: { owner: string; limit: number | undefined }[]
  reads: number
  projects: Project[]
  revision: string
  ownerHistoryResult?: Result<GitStoreCommitInfo[]>
}

type CaddyApplicationFake = Pick<CaddyApplication, "projectChange" | "regenerate" | "status"> & {
  projectChanges: number
  regenerations: number
}

type AccessLogSourceFake = ProjectAccessLogSource & {
  calls: { owner: string; name: string; options?: ProjectAccessLogReadOptions }[]
  result: Result<ProjectAccessLogPage>
}

function accessLogSourceCreate(result: Result<ProjectAccessLogPage>): AccessLogSourceFake {
  const source = {
    calls: [],
    result,
    read: async (project: { owner: string; name: string }, options?: ProjectAccessLogReadOptions) => {
      source.calls.push({ owner: project.owner, name: project.name, options })
      return source.result
    },
  } as AccessLogSourceFake
  return source
}

function socketAccessCreate(username: string, role: Role, ownerRoles: Record<string, Role | undefined>): ProjectAccess {
  return {
    actorResolve: async () => createResult({ subject: `${username}-subject`, username, role }),
    ownerRoleResolve: async (owner) => createResult(ownerRoles[owner]),
  }
}

function projectsCreate(): Project[] {
  return [
    caddyConfigGenerateFixtures.proxy,
    {
      ...caddyConfigGenerateFixtures.static,
      owner: "david",
      name: "david-app",
      caddy: {
        ...caddyConfigGenerateFixtures.static.caddy,
        port: 4100,
        domains: ["david.example"],
        path: "/home/david/projects/app",
      },
    },
  ]
}

function docsProjectCreate(
  owner: string,
  name: string,
  domains: string[],
  options: { docs?: boolean; disabled?: boolean } = {},
): Project {
  return {
    schemaVersion: 1,
    owner,
    name,
    type: "customer",
    order: 0,
    services: [],
    caddy: {
      port: 4400,
      domains,
      path: "/srv/docs",
      access: "external",
      kind: "proxy",
      docs: options.docs ?? true,
      browse: false,
      headerUp: {},
      disabled: options.disabled ?? false,
      denyDotfiles: false,
      spa: false,
    },
  }
}

function commit(sha: string, date: string, message: string): GitStoreCommitInfo {
  return { sha, date, author: "project-registry", message }
}

function repositoryCreate(): RepositoryFake {
  const projects = projectsCreate()
  const histories: Record<string, GitStoreCommitInfo[]> = {
    "leo/opencode": [commit("b".repeat(40), "2026-08-20T12:00:00.000Z", "edit leo/opencode")],
    "david/david-app": [commit("c".repeat(40), "2026-08-21T12:00:00.000Z", "edit david/david-app")],
  }
  const repository: RepositoryFake = {
    historyKeys: [],
    ownerHistoryCalls: [],
    reads: 0,
    projects,
    revision,
    read: async () => {
      repository.reads += 1
      return createResult({ projects: repository.projects, revision: repository.revision })
    },
    get: async (key) => {
      const project = repository.projects.find((item) => item.owner === key.owner && item.name === key.name)
      return project === undefined
        ? createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found")
        : createResult({ project, revision: repository.revision })
    },
    create: async (project, options) => {
      if (options.expectedRevision !== repository.revision) {
        return createResultErrorCode("projectRepositoryCreate", "revision mismatch", "projects.conflict")
      }
      const value = project as Project
      if (repository.projects.some((item) => item.owner === value.owner && item.name === value.name)) {
        return createResultErrorCode("projectRepositoryCreate", "project already exists", "projects.conflict")
      }
      repository.projects.push(value)
      repository.revision = nextRevision
      return createResult(mutation("create", value, true, repository.revision))
    },
    edit: async (key, project, options) => {
      if (options.expectedRevision !== repository.revision) {
        return createResultErrorCode("projectRepositoryEdit", "revision mismatch", "projects.conflict")
      }
      const index = repository.projects.findIndex((item) => item.owner === key.owner && item.name === key.name)
      if (index < 0) return createResultErrorCode("projectRepositoryEdit", "project not found", "projects.not-found")
      const value = project as Project
      const changed = JSON.stringify(repository.projects[index]) !== JSON.stringify(value)
      if (changed) {
        repository.projects[index] = value
        repository.revision = nextRevision
      }
      return createResult(mutation("edit", key, changed, repository.revision))
    },
    delete: async (key, options) => {
      if (options.expectedRevision !== repository.revision) {
        return createResultErrorCode("projectRepositoryDelete", "revision mismatch", "projects.conflict")
      }
      const index = repository.projects.findIndex((item) => item.owner === key.owner && item.name === key.name)
      if (index < 0) return createResultErrorCode("projectRepositoryDelete", "project not found", "projects.not-found")
      repository.projects.splice(index, 1)
      repository.revision = nextRevision
      return createResult(mutation("delete", key, true, repository.revision))
    },
    history: async (key) => {
      if (key === undefined) return createResultError("test", "unscoped history is forbidden")
      repository.historyKeys.push(key)
      return createResult(histories[`${key.owner}/${key.name}`] ?? [])
    },
    ownerHistory: async (owner, limit) => {
      repository.ownerHistoryCalls.push({ owner, limit })
      if (repository.ownerHistoryResult !== undefined) return repository.ownerHistoryResult
      const ownerHistory =
        owner === "leo"
          ? [
              commit("d".repeat(40), "2026-08-21T12:00:00.000Z", "edit leo/second"),
              commit("b".repeat(40), "2026-08-20T12:00:00.000Z", "edit leo/opencode"),
            ]
          : (histories["david/david-app"] ?? [])
      return createResult(limit === undefined ? ownerHistory : ownerHistory.slice(0, limit))
    },
    readiness: async () => createResult({ ready: true, clean: true, revision: repository.revision }),
    recover: async () => createResult({ ready: true, clean: true, revision: repository.revision }),
  }
  return repository
}

function mutation(
  action: ProjectRepositoryMutation["action"],
  key: ProjectKey,
  changed: boolean,
  mutationRevision: string,
): ProjectRepositoryMutation {
  return {
    action,
    key: { owner: key.owner, name: key.name },
    changed,
    revision: mutationRevision,
    localCommit: { status: changed ? "committed" : "unchanged", revision: mutationRevision },
    push: { requested: false, status: "not-requested" },
  }
}

function caddyApplicationCreate(): CaddyApplicationFake {
  const application: CaddyApplicationFake = {
    projectChanges: 0,
    regenerations: 0,
    projectChange: async () => {
      application.projectChanges += 1
      return createResult({ revision: nextRevision, changed: true, applied: true, attempts: 1 })
    },
    regenerate: async () => {
      application.regenerations += 1
      return createResult({ revision: nextRevision, changed: true, applied: true, attempts: 1 })
    },
    status: () => ({ desiredRevision: revision, appliedRevision: revision, pending: false, lastSuccess: 42 }),
  }
  return application
}

function projectRegistryApiHandlerCreate(
  options: Parameters<typeof projectRegistryApiHandlerCreateProduction>[0],
): ReturnType<typeof projectRegistryApiHandlerCreateProduction> {
  return projectRegistryApiHandlerCreateProduction({
    ...options,
    socketAccessResolve:
      options.socketAccessResolve ??
      (async (username) => createResult(socketAccessCreate(username, "own", { [username]: "own" }))),
  })
}

async function requestJson(
  handler: ReturnType<typeof projectRegistryApiHandlerCreate>,
  path: string,
  context: ProjectRegistryDaemonRequestContext,
  method = "GET",
  body?: unknown,
): Promise<{ response: Response; body: Record<string, unknown> }> {
  const response = await handler(
    new Request(`http://localhost${path}`, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: body === undefined ? undefined : { "content-type": "application/json" },
    }),
    context,
  )
  return { response, body: (await response.json()) as Record<string, unknown> }
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    const directory = temporaryDirectories.pop()
    if (directory !== undefined) rmSync(directory, { recursive: true, force: true })
  }
})

describe("projectRegistryApiHandlerCreate", () => {
  test("serves owner-scoped versioned list, get, history, config, and status reads", async () => {
    const repository = repositoryCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const listed = await requestJson(handler, "/api/v1/users/leo/projects", leo)
    expect(listed.response.status).toBe(200)
    expect(listed.body).toMatchObject({
      success: true,
      data: { revision, projects: [{ owner: "leo", name: "opencode" }] },
    })

    const project = await requestJson(handler, "/api/v1/users/leo/projects/opencode", leo)
    expect(project.response.status).toBe(200)
    expect(project.body).toMatchObject({
      success: true,
      data: { revision, project: { owner: "leo", name: "opencode" } },
    })

    const history = await requestJson(handler, "/api/v1/users/leo/projects/opencode/history?limit=1", leo)
    expect(history.response.status).toBe(200)
    expect(history.body).toMatchObject({ success: true, data: [{ message: "edit leo/opencode" }] })

    const config = await requestJson(handler, "/api/v1/caddy/config", leo)
    expect(config.response.status).toBe(200)
    expect(config.body).toMatchObject({ success: true, data: { projectCount: 1, summary: [{ owner: "leo" }] } })
    expect(JSON.stringify(config.body)).toContain("opencode.example")
    expect(JSON.stringify(config.body)).not.toContain("david.example")

    const status = await requestJson(handler, "/api/v1/caddy/status", leo)
    expect(status.response.status).toBe(200)
    expect(status.body).toEqual({
      success: true,
      data: { desiredRevision: revision, appliedRevision: revision, pending: false, lastSuccess: 42 },
    })
  })

  test("keeps legacy read aliases usable while scoping all data to the socket owner", async () => {
    const repository = repositoryCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const listed = await requestJson(handler, "/projects", leo)
    expect(listed.body).toMatchObject({
      success: true,
      data: [{ name: "opencode", user: "leo", port: 4096, domains: ["opencode.example", "oc.example"] }],
    })
    expect(JSON.stringify(listed.body)).not.toContain("david-app")

    const project = await requestJson(handler, "/projects/opencode", leo)
    expect(project.body).toMatchObject({ success: true, data: { name: "opencode", user: "leo", port: 4096 } })

    const summary = await requestJson(handler, "/config?summary=1", leo)
    expect(summary.body).toMatchObject({ success: true, data: [{ name: "opencode", user: "leo", port: 4096 }] })
    expect(JSON.stringify(summary.body)).not.toContain("david")

    const selectedResponse = await handler(new Request("http://localhost/config?select=opencode&pretty=1"), leo)
    expect(selectedResponse.status).toBe(200)
    const selected = (await selectedResponse.json()) as unknown[]
    expect(selected).toHaveLength(1)
    expect(JSON.stringify(selected)).toContain("opencode.example")
    expect(JSON.stringify(selected)).not.toContain("david.example")

    const hiddenSelection = await requestJson(handler, "/config?select=david-app", leo)
    expect(hiddenSelection.response.status).toBe(404)
    expect(hiddenSelection.body).toMatchObject({ success: false, code: "caddy.not-found" })

    const namedHistory = await requestJson(handler, "/history?name=opencode", leo)
    expect(namedHistory.body).toMatchObject({ success: true, data: [{ message: "edit leo/opencode" }] })

    repository.historyKeys.length = 0
    repository.ownerHistoryCalls.length = 0
    const ownerHistory = await requestJson(handler, "/history?limit=1", leo)
    expect(ownerHistory.body).toMatchObject({ success: true, data: [{ message: "edit leo/second" }] })
    expect(repository.ownerHistoryCalls).toEqual([{ owner: "leo", limit: 1 }])
    expect(repository.historyKeys).toEqual([])

    repository.ownerHistoryCalls.length = 0
    const davidHistory = await requestJson(handler, "/history", { transport: "unix", username: "david" })
    expect(davidHistory.body).toMatchObject({ success: true, data: [{ message: "edit david/david-app" }] })
    expect(repository.ownerHistoryCalls).toEqual([{ owner: "david", limit: undefined }])
    expect(repository.historyKeys).toEqual([])
  })

  test("maps owner history repository failures through the legacy error envelope", async () => {
    const repository = repositoryCreate()
    repository.ownerHistoryResult = createResultErrorCode(
      "projectRepositoryOwnerHistory",
      "worktree is dirty",
      "projects.conflict",
    )
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })

    const history = await requestJson(handler, "/history?limit=2", { transport: "unix", username: "leo" })

    expect(history.response.status).toBe(409)
    expect(history.body).toEqual({
      success: false,
      op: "projectRepositoryOwnerHistory",
      errorMessage: "worktree is dirty",
      code: "projects.conflict",
    })
    expect(repository.ownerHistoryCalls).toEqual([{ owner: "leo", limit: 2 }])
    expect(repository.historyKeys).toEqual([])
  })

  test("does not classify unstructured result messages as HTTP errors", async () => {
    const repository = repositoryCreate()
    repository.ownerHistoryResult = createResultError("projectRepositoryOwnerHistory", "project not found")
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })

    const history = await requestJson(handler, "/history?limit=2", {
      transport: "unix",
      username: "leo",
    })

    expect(history.response.status).toBe(500)
    expect(history.body).toMatchObject({ success: false, code: "platform.internal" })
  })

  test("isolates leo and david and rejects cross-owner versioned reads before repository access", async () => {
    const repository = repositoryCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const david = { transport: "unix", username: "david" } as const

    const davidProjects = await requestJson(handler, "/api/v1/users/david/projects", david)
    expect(davidProjects.body).toMatchObject({
      success: true,
      data: { projects: [{ owner: "david", name: "david-app" }] },
    })

    const readsBefore = repository.reads
    const crossOwner = await requestJson(handler, "/api/v1/users/leo/projects", david)
    expect(crossOwner.response.status).toBe(403)
    expect(crossOwner.body).toMatchObject({
      success: false,
      error: { code: "projects.forbidden", status: 403, retryable: false, details: {} },
    })
    expect(repository.reads).toBe(readsBefore)

    const forgedIdentity = await requestJson(handler, "/api/v1/users/leo/projects?owner=leo", {
      transport: "unix",
      username: "david",
    })
    expect(forgedIdentity.response.status).toBe(403)

    const headerResponse = await handler(
      new Request("http://localhost/api/v1/users/leo/projects", { headers: { "x-user": "leo" } }),
      { transport: "unix", username: "david" },
    )
    expect(headerResponse.status).toBe(403)

    const hiddenLegacyProject = await requestJson(handler, "/projects/opencode", david)
    expect(hiddenLegacyProject.response.status).toBe(404)
    expect(hiddenLegacyProject.body).toMatchObject({ success: false, code: "projects.not-found" })
  })

  test("creates, updates, and deletes versioned owner projects and applies Caddy after each change", async () => {
    const repository = repositoryCreate()
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: application,
      portRange: { from: 4100, to: 4199 },
    })
    const leo = { transport: "unix", username: "leo" } as const

    const created = await requestJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: revision,
      name: "new-app",
      caddy: { domains: ["new.example"] },
    })
    expect(created.response.status).toBe(201)
    expect(created.body).toMatchObject({
      success: true,
      data: { action: "create", changed: true, key: { owner: "leo", name: "new-app" } },
    })
    expect(repository.projects).toContainEqual(
      expect.objectContaining({ owner: "leo", name: "new-app", caddy: expect.objectContaining({ port: 4101 }) }),
    )

    const updated = await requestJson(handler, "/api/v1/users/leo/projects/new-app", leo, "PATCH", {
      expectedRevision: nextRevision,
      description: "updated",
    })
    expect(updated.response.status).toBe(200)
    expect(updated.body).toMatchObject({ success: true, data: { action: "edit", changed: true } })
    expect(repository.projects).toContainEqual(expect.objectContaining({ name: "new-app", description: "updated" }))

    const deleted = await requestJson(handler, "/api/v1/users/leo/projects/new-app", leo, "DELETE", {
      expectedRevision: nextRevision,
    })
    expect(deleted.response.status).toBe(200)
    expect(deleted.body).toMatchObject({ success: true, data: { action: "delete", changed: true } })
    expect(repository.projects.some((project) => project.name === "new-app")).toBe(false)
    expect(application.projectChanges).toBe(3)
  })

  test("does not trigger Caddy or advance the revision for a no-op update", async () => {
    const repository = repositoryCreate()
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: application })
    const leo = { transport: "unix", username: "leo" } as const

    const updated = await requestJson(handler, "/api/v1/users/leo/projects/opencode", leo, "PATCH", {
      expectedRevision: revision,
    })

    expect(updated.response.status).toBe(200)
    expect(updated.body).toMatchObject({
      success: true,
      data: { changed: false, revision, localCommit: { status: "unchanged" } },
    })
    expect(repository.revision).toBe(revision)
    expect(application.projectChanges).toBe(0)
  })

  test("rejects invalid schemas, stale revisions, and duplicate active domains and ports deterministically", async () => {
    const repository = repositoryCreate()
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: application })
    const leo = { transport: "unix", username: "leo" } as const

    const invalid = await requestJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: revision,
      name: "INVALID",
    })
    expect(invalid.response.status).toBe(400)
    expect(invalid.body).toMatchObject({ success: false, error: { code: "request.invalid", status: 400 } })

    const stale = await requestJson(handler, "/api/v1/users/leo/projects/opencode", leo, "PATCH", {
      expectedRevision: "c".repeat(40),
      description: "stale",
    })
    expect(stale.response.status).toBe(409)
    expect(stale.body).toMatchObject({ success: false, error: { code: "projects.conflict", status: 409 } })

    const duplicateDomain = await requestJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: revision,
      name: "duplicate-domain",
      caddy: { port: 4190, domains: ["OPENCODE.EXAMPLE."] },
    })
    expect(duplicateDomain.response.status).toBe(409)
    expect(duplicateDomain.body).toMatchObject({ success: false, error: { code: "projects.conflict" } })

    const duplicatePort = await requestJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: revision,
      name: "duplicate-port",
      caddy: { port: 4096, domains: ["different.example"] },
    })
    expect(duplicatePort.response.status).toBe(409)
    expect(duplicatePort.body).toMatchObject({ success: false, error: { code: "projects.conflict" } })
    expect(application.projectChanges).toBe(0)
  })

  test("denies cross-owner and HTTP mutations before repository changes", async () => {
    const repository = repositoryCreate()
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: application })

    const crossOwner = await requestJson(
      handler,
      "/api/v1/users/leo/projects/opencode",
      { transport: "unix", username: "david" },
      "PATCH",
      { expectedRevision: revision, description: "forged" },
    )
    expect(crossOwner.response.status).toBe(403)

    const bodyOwner = await requestJson(
      handler,
      "/api/v1/users/david/projects",
      { transport: "unix", username: "david" },
      "POST",
      { expectedRevision: revision, owner: "leo", name: "forged" },
    )
    expect(bodyOwner.response.status).toBe(403)

    const denied = await requestJson(handler, "/api/v1/users/leo/projects/opencode", { transport: "http" }, "DELETE", {
      expectedRevision: revision,
    })
    expect(denied.response.status).toBe(401)
    expect(repository.revision).toBe(revision)
    expect(application.projectChanges).toBe(0)
  })

  test("supports legacy PUT, PATCH, DELETE, and regenerate response semantics", async () => {
    const repository = repositoryCreate()
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: application })
    const leo = { transport: "unix", username: "leo" } as const

    const replaced = await requestJson(handler, "/projects/opencode", leo, "PUT", {
      name: "ignored-name",
      user: "forged-user",
      port: 4200,
      domains: ["replaced.example"],
      path: "",
      docs: false,
    })
    expect(replaced.response.status).toBe(200)
    expect(replaced.body).toMatchObject({
      success: true,
      data: { name: "opencode", user: "leo", port: 4200, domains: ["replaced.example"], docs: false },
    })

    const patched = await requestJson(handler, "/projects/opencode", leo, "PATCH", { port: 4201 })
    expect(patched.response.status).toBe(200)
    expect(patched.body).toMatchObject({ success: true, data: { name: "opencode", user: "leo", port: 4201 } })

    const regenerated = await requestJson(handler, "/regenerate", leo, "POST")
    expect(regenerated.response.status).toBe(200)
    expect(regenerated.body).toMatchObject({ success: true, data: { applied: true } })

    const deleted = await requestJson(handler, "/projects/opencode", leo, "DELETE")
    expect(deleted.response.status).toBe(200)
    expect(deleted.body).toEqual({ success: true, data: { deleted: "opencode" } })
    expect(application.projectChanges).toBe(3)
    expect(application.regenerations).toBe(1)
  })

  test("deletes the current owner's legacy project by numeric Caddy port", async () => {
    const repository = repositoryCreate()
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: application })

    const crossOwner = await requestJson(
      handler,
      "/projects/by-port/4096",
      { transport: "unix", username: "david" },
      "DELETE",
    )
    expect(crossOwner.response.status).toBe(404)
    expect(crossOwner.body).toEqual({
      success: false,
      op: "projectDeleteByPort",
      errorMessage: "no project with port 4096",
      code: "projects.not-found",
    })
    expect(application.projectChanges).toBe(0)

    const invalid = await requestJson(
      handler,
      "/projects/by-port/not-a-port",
      { transport: "unix", username: "leo" },
      "DELETE",
    )
    expect(invalid.response.status).toBe(404)
    expect(invalid.body).toMatchObject({ success: false, code: "api.not-found" })

    const deleted = await requestJson(
      handler,
      "/projects/by-port/4096",
      { transport: "unix", username: "leo" },
      "DELETE",
    )
    expect(deleted.response.status).toBe(200)
    expect(deleted.body).toEqual({ success: true, data: { deleted: "opencode" } })
    expect(repository.projects.some((project) => project.name === "opencode")).toBe(false)
    expect(application.projectChanges).toBe(1)

    const missing = await requestJson(
      handler,
      "/projects/by-port/4096",
      { transport: "unix", username: "leo" },
      "DELETE",
    )
    expect(missing.response.status).toBe(404)
    expect(missing.body).toMatchObject({ success: false, code: "projects.not-found" })
  })

  test("keeps a project named by-port on the legacy name route", async () => {
    const repository = repositoryCreate()
    repository.projects.push(docsProjectCreate("leo", "by-port", ["by-port.example"]))
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: application })

    const deleted = await requestJson(handler, "/projects/by-port", { transport: "unix", username: "leo" }, "DELETE")

    expect(deleted.response.status).toBe(200)
    expect(deleted.body).toEqual({ success: true, data: { deleted: "by-port" } })
    expect(repository.projects.some((project) => project.name === "by-port")).toBe(false)
    expect(repository.projects.some((project) => project.name === "opencode")).toBe(true)
    expect(application.projectChanges).toBe(1)
  })

  test("serves the legacy docs CLI request with normalized paths and socket-owner domains", async () => {
    const repository = repositoryCreate()
    repository.projects.push(docsProjectCreate("leo", "docsapp", ["docs.example", "docs-alt.example"]))
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const defaultScheme = await requestJson(
      handler,
      `/projects/docsapp/docs?${new URLSearchParams({ path: "guide/intro.md" })}`,
      leo,
    )
    expect(defaultScheme.response.status).toBe(200)
    expect(defaultScheme.body).toEqual({
      success: true,
      data: {
        urls: ["https://docs.example/docs/guide/intro.md", "https://docs-alt.example/docs/guide/intro.md"],
      },
    })

    const prefixed = await requestJson(
      handler,
      `/projects/docsapp/docs?${new URLSearchParams({ path: "/docs/guide/intro.md" })}`,
      leo,
    )
    expect(prefixed.body).toEqual(defaultScheme.body)

    const explicitHttp = await requestJson(
      handler,
      `/projects/docsapp/docs?${new URLSearchParams({ path: "docs/guide/intro.md", scheme: "http" })}`,
      leo,
    )
    expect(explicitHttp.body).toEqual({
      success: true,
      data: {
        urls: ["http://docs.example/docs/guide/intro.md", "http://docs-alt.example/docs/guide/intro.md"],
      },
    })
  })

  test("serves versioned owner-bound documentation URLs and errors", async () => {
    const repository = repositoryCreate()
    repository.projects.push(docsProjectCreate("leo", "docsapp", ["docs.example"]))
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const docs = await requestJson(
      handler,
      `/api/v1/users/leo/projects/docsapp/docs?${new URLSearchParams({ path: "guide.md", scheme: "http" })}`,
      leo,
    )
    expect(docs.response.status).toBe(200)
    expect(docs.body).toEqual({ success: true, data: { urls: ["http://docs.example/docs/guide.md"] } })

    const missing = await requestJson(handler, "/api/v1/users/leo/projects/missing/docs?path=guide.md", leo)
    expect(missing.response.status).toBe(404)
    expect(missing.body).toMatchObject({
      success: false,
      error: { code: "projects.not-found", status: 404, retryable: false, details: {} },
    })

    const crossOwner = await requestJson(handler, "/api/v1/users/leo/projects/docsapp/docs?path=guide.md", {
      transport: "unix",
      username: "david",
    })
    expect(crossOwner.response.status).toBe(403)
  })

  test("returns distinct structured documentation failures and safe enablement hints", async () => {
    const repository = repositoryCreate()
    repository.projects.push(
      docsProjectCreate("leo", "docsapp", ["docs.example"]),
      docsProjectCreate("leo", "disabled-docs", ["disabled.example"], { disabled: true }),
      docsProjectCreate("leo", "no-docs", ["no-docs.example"], { docs: false }),
    )
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const disabled = await requestJson(handler, "/api/v1/users/leo/projects/disabled-docs/docs?path=guide.md", leo)
    expect(disabled.response.status).toBe(409)
    expect(disabled.body).toMatchObject({
      success: false,
      error: {
        code: "projects.disabled",
        hint: "Run: project-registry project edit disabled-docs --enabled --docs",
      },
    })

    const noDocs = await requestJson(handler, "/api/v1/users/leo/projects/no-docs/docs?path=guide.md", leo)
    expect(noDocs.response.status).toBe(409)
    expect(noDocs.body).toMatchObject({
      success: false,
      error: {
        code: "documentation.disabled",
        hint: "Run: project-registry project edit no-docs --docs",
      },
    })

    const invalidPath = await requestJson(handler, "/api/v1/users/leo/projects/docsapp/docs?path=guide.html", leo)
    expect(invalidPath.response.status).toBe(400)
    expect(invalidPath.body).toMatchObject({ success: false, error: { code: "documentation.invalid-path" } })

    const invalidOptions = await requestJson(
      handler,
      "/api/v1/users/leo/projects/docsapp/docs?path=guide.md&scheme=ftp",
      leo,
    )
    expect(invalidOptions.response.status).toBe(400)
    expect(invalidOptions.body).toMatchObject({ success: false, error: { code: "documentation.invalid-options" } })
  })

  test("keeps legacy docs errors scoped, safe, and GET-only", async () => {
    const repository = repositoryCreate()
    repository.projects.push(
      docsProjectCreate("leo", "docsapp", ["docs.example"]),
      docsProjectCreate("leo", "disabled-docs", ["disabled.example"], { disabled: true }),
      docsProjectCreate("leo", "no-docs", ["no-docs.example"], { docs: false }),
      docsProjectCreate("david", "cross-owner", ["private.example"]),
    )
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const notFound = await requestJson(handler, "/projects/unknown/docs?path=guide.md", leo)
    expect(notFound.response.status).toBe(404)
    expect(notFound.body).toEqual({
      success: false,
      op: "projectDocsUrlsUseCase",
      errorMessage: "documentation project is unavailable",
    })

    const crossOwner = await requestJson(handler, "/projects/cross-owner/docs?path=guide.md", leo)
    expect(crossOwner.response.status).toBe(404)
    expect(crossOwner.body).toEqual(notFound.body)

    for (const [name, errorMessage] of [
      ["disabled-docs", "documentation project is disabled"],
      ["no-docs", "documentation is disabled"],
    ] as const) {
      const unavailable = await requestJson(handler, `/projects/${name}/docs?path=guide.md`, leo)
      expect(unavailable.response.status).toBe(400)
      expect(unavailable.body).toEqual({
        success: false,
        op: "projectDocsUrlsUseCase",
        errorMessage,
      })
    }

    for (const path of ["../secret.md", "/etc/passwd", "guide.html", "guide\0.md"]) {
      const invalid = await requestJson(handler, `/projects/docsapp/docs?${new URLSearchParams({ path })}`, leo)
      expect(invalid.response.status).toBe(400)
      expect(invalid.body).toEqual({
        success: false,
        op: "projectDocsUrlsUseCase",
        errorMessage: "documentation path is invalid",
      })
    }

    for (const path of ["/projects/%2Funsafe/docs?path=guide.md", "/projects/%2e%2e/docs?path=guide.md"]) {
      const unsafeProject = await requestJson(handler, path, leo)
      expect(unsafeProject.response.status).toBe(404)
      expect(unsafeProject.body).toMatchObject({ success: false })
    }

    const method = await requestJson(handler, "/projects/docsapp/docs?path=guide.md", leo, "POST")
    expect(method.response.status).toBe(405)
    expect(method.response.headers.get("allow")).toBe("GET")

    const http = await requestJson(handler, "/projects/docsapp/docs?path=guide.md", { transport: "http" })
    expect(http.response.status).toBe(401)
  })

  test("exposes explicit versioned regeneration", async () => {
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository: repositoryCreate(), caddyApplication: application })

    const regenerated = await requestJson(
      handler,
      "/api/v1/caddy/regenerate",
      { transport: "unix", username: "leo" },
      "POST",
    )

    expect(regenerated.response.status).toBe(200)
    expect(regenerated.body).toMatchObject({ success: true, data: { changed: true, applied: true, attempts: 1 } })
    expect(application.regenerations).toBe(1)
  })

  test("serves bounded access-log pages over the shared Unix and HTTP request boundary", async () => {
    const source = accessLogSourceCreate(
      createResult({ records: [caddyAccessLogFixture], next: "next-cursor", partial: false, malformedLines: 0 }),
    )
    const handler = projectRegistryApiHandlerCreate({
      repository: repositoryCreate(),
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: source,
    })
    const access = {
      actorResolve: async () => createResult({ subject: "subject", username: "leo", role: "own" as const }),
      ownerRoleResolve: async () => createResult("own" as const),
    }

    const unix = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs?limit=2&before=opaque", {
      transport: "unix",
      username: "leo",
    })
    const http = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs?limit=2", {
      transport: "http",
      access,
    })

    expect(unix.response.status).toBe(200)
    expect(http.response.status).toBe(200)
    expect(unix.response.headers.get("cache-control")).toBe("no-store")
    expect(http.response.headers.get("cache-control")).toBe("no-store")
    expect(unix.body).toMatchObject({ success: true, data: { next: "next-cursor" } })
    expect(unix.body).toMatchObject({ success: true, data: { records: [caddyAccessLogFixture] } })
    expect(source.calls).toEqual([
      { owner: "leo", name: "opencode", options: { limit: 2, before: "opaque" } },
      { owner: "leo", name: "opencode", options: { limit: 2 } },
    ])
  })

  test("infers ownerless access-log requests from the Unix socket username only", async () => {
    const source = accessLogSourceCreate(
      createResult({ records: [], next: undefined, partial: false, malformedLines: 0 }),
    )
    const handler = projectRegistryApiHandlerCreate({
      repository: repositoryCreate(),
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: source,
    })

    const inferred = await requestJson(handler, "/api/v1/projects/opencode/access-logs", {
      transport: "unix",
      username: "leo",
    })
    const http = await requestJson(handler, "/api/v1/projects/opencode/access-logs", {
      transport: "http",
      access: socketAccessCreate("leo", "own", { leo: "own" }),
    })

    expect(inferred.response.status).toBe(200)
    expect(http.response.status).toBe(404)
    expect(http.body).toMatchObject({ success: false, error: { code: "api.not-found", status: 404 } })
    expect(source.calls).toEqual([{ owner: "leo", name: "opencode", options: { limit: 100 } }])
  })

  test("ignores injected Unix access and resolves only the socket-bound username", async () => {
    const repository = repositoryCreate()
    repository.projects.push(docsProjectCreate("root", "root-app", ["root.example"]))
    const resolvedUsers: string[] = []
    const handler = projectRegistryApiHandlerCreateProduction({
      repository,
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: accessLogSourceCreate(
        createResult({ records: [], next: undefined, partial: false, malformedLines: 0 }),
      ),
      socketAccessResolve: async (username) => {
        resolvedUsers.push(username)
        return createResult(
          socketAccessCreate(username, username === "root" ? "superadmin" : "own", {
            leo: "own",
            root: "superadmin",
          }),
        )
      },
    })

    const spoofed = await requestJson(handler, "/api/v1/users/root/projects/root-app/access-logs", {
      transport: "unix",
      username: "leo",
      access: socketAccessCreate("root", "superadmin", { root: "superadmin" }),
    } as unknown as ProjectRegistryDaemonRequestContext)

    expect(spoofed.response.status).toBe(404)
    expect(resolvedUsers).toEqual(["leo"])
  })

  test("rejects Unix project access when the trusted socket resolver is absent", async () => {
    const handler = projectRegistryApiHandlerCreateProduction({
      repository: repositoryCreate(),
      caddyApplication: caddyApplicationCreate(),
    })

    const response = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs", {
      transport: "unix",
      username: "leo",
      access: socketAccessCreate("root", "superadmin", { leo: "own" }),
    } as unknown as ProjectRegistryDaemonRequestContext)

    expect(response.response.status).toBe(401)
    expect(response.body).toMatchObject({ error: { code: "api.unauthenticated", status: 401 } })
  })

  test("uses trusted socket roles for cross-owner access without changing socket identity", async () => {
    const repository = repositoryCreate()
    repository.projects.push(docsProjectCreate("root", "root-app", ["root.example"]))
    const source = accessLogSourceCreate(
      createResult({ records: [], next: undefined, partial: false, malformedLines: 0 }),
    )
    const ownerRoles: Record<string, Role | undefined> = { leo: "own", david: "admin", root: "superadmin" }
    const handler = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: source,
      socketAccessResolve: async (username) => {
        const role = ownerRoles[username]
        return role === undefined
          ? createResultError("socketAccessResolve", "socket actor role is unavailable")
          : createResult(socketAccessCreate(username, role, ownerRoles))
      },
    })

    const admin = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs", {
      transport: "unix",
      username: "david",
    })
    expect(admin.response.status).toBe(200)

    const forgedAdmin = await requestJson(handler, "/api/v1/users/root/projects/root-app/access-logs", {
      transport: "unix",
      username: "david",
    })
    expect(forgedAdmin.response.status).toBe(404)
    expect(forgedAdmin.body).toMatchObject({ error: { code: "access-log.not-found", status: 404 } })

    const own = await requestJson(handler, "/api/v1/users/david/projects/david-app/access-logs", {
      transport: "unix",
      username: "leo",
    })
    expect(own.response.status).toBe(404)

    const superadmin = await requestJson(handler, "/api/v1/users/root/projects/root-app/access-logs", {
      transport: "unix",
      username: "root",
    })
    expect(superadmin.response.status).toBe(200)

    const mismatchedHandler = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: source,
      socketAccessResolve: async () => createResult(socketAccessCreate("root", "superadmin", ownerRoles)),
    })
    const mismatched = await requestJson(mismatchedHandler, "/api/v1/users/leo/projects/opencode/access-logs", {
      transport: "unix",
      username: "david",
    })
    expect(mismatched.response.status).toBe(401)

    expect(source.calls.map((call) => `${call.owner}/${call.name}`)).toEqual(["leo/opencode", "root/root-app"])
  })

  test("maps missing and unauthorized projects to indistinguishable 404s", async () => {
    const source = accessLogSourceCreate(createResult({ records: [], partial: false, malformedLines: 0 }))
    const handler = projectRegistryApiHandlerCreate({
      repository: repositoryCreate(),
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: source,
    })

    const missing = await requestJson(handler, "/api/v1/users/leo/projects/missing/access-logs", {
      transport: "unix",
      username: "leo",
    })
    const unauthorized = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs", {
      transport: "unix",
      username: "david",
    })

    expect(missing.response.status).toBe(404)
    expect(unauthorized.response.status).toBe(404)
    expect(missing.body).toEqual(unauthorized.body)
    expect(missing.body).toMatchObject({
      error: {
        code: "access-log.not-found",
        hint: "Check the project name and your access permissions, then refresh the list.",
      },
    })
    expect(missing.response.headers.get("cache-control")).toBe("no-store")
    expect(source.calls).toHaveLength(0)
  })

  test("maps malformed, expired, disabled, catalog-only, and unavailable storage states", async () => {
    const repository = repositoryCreate()
    repository.projects.push(docsProjectCreate("leo", "disabled", ["disabled.example"], { disabled: true }), {
      schemaVersion: 1,
      owner: "leo",
      name: "catalog",
      type: "customer",
      order: 0,
      services: [],
    })
    const source = accessLogSourceCreate(createResult({ records: [], partial: false, malformedLines: 0 }))
    const handler = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: caddyApplicationCreate(),
      projectAccessLogSource: source,
    })
    const leo = { transport: "unix", username: "leo" } as const

    const malformed = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs?limit=0", leo)
    expect(malformed.response.status).toBe(400)
    expect(malformed.body).toMatchObject({
      success: false,
      error: {
        code: "access-log.invalid-input",
        status: 400,
        hint: "Use a limit from 1 through 1000 and a cursor returned by the API.",
      },
    })

    source.result = {
      ...createResultError("projectAccessLogSourceFile", "access log cursor is invalid"),
      code: "access-log.invalid-cursor",
    } as unknown as Result<ProjectAccessLogPage>
    const invalidCursor = await requestJson(
      handler,
      "/api/v1/users/leo/projects/opencode/access-logs?before=opaque",
      leo,
    )
    expect(invalidCursor.response.status).toBe(400)
    expect(invalidCursor.body).toMatchObject({
      success: false,
      error: {
        code: "access-log.invalid-cursor",
        status: 400,
        hint: "Use a cursor returned by the API.",
      },
    })

    source.result = {
      ...createResultError("projectAccessLogSourceFile", "access log cursor has expired"),
      code: "access-log.cursor-expired",
    } as unknown as Result<ProjectAccessLogPage>
    const expired = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs?before=opaque", leo)
    expect(expired.response.status).toBe(410)
    expect(expired.body).toMatchObject({
      success: false,
      error: {
        code: "access-log.cursor-expired",
        status: 410,
        hint: "Refresh the access-log list to start a new page.",
      },
    })

    source.result = {
      ...createResultError("projectAccessLogSourceFile", "access log storage is unavailable"),
      code: "access-log.storage-unavailable",
    } as unknown as Result<ProjectAccessLogPage>
    const storageUnavailable = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs", leo)
    expect(storageUnavailable.response.status).toBe(503)
    expect(storageUnavailable.body).toMatchObject({
      success: false,
      error: {
        code: "access-log.storage-unavailable",
        status: 503,
        retryable: true,
        hint: "Check the configured access-log directory and daemon permissions, then retry.",
      },
    })

    source.result = {
      ...createResultError("projectAccessLogSourceFile", "access log changed while being read"),
      code: "access-log.rotation-race",
    } as unknown as Result<ProjectAccessLogPage>
    const transient = await requestJson(handler, "/api/v1/users/leo/projects/opencode/access-logs", leo)
    expect(transient.response.status).toBe(503)
    expect(transient.body).toMatchObject({
      success: false,
      error: {
        code: "access-log.rotation-race",
        status: 503,
        retryable: true,
        hint: "The log changed while it was being read. Refresh the list and retry.",
      },
    })

    for (const name of ["disabled", "catalog"]) {
      const unavailable = await requestJson(handler, `/api/v1/users/leo/projects/${name}/access-logs`, leo)
      expect(unavailable.response.status).toBe(503)
      expect(unavailable.body).toMatchObject({
        success: false,
        error: {
          code: "access-log.unavailable",
          status: 503,
          retryable: true,
          hint: "Enable access-log storage in the daemon configuration and retry.",
        },
      })
    }
    expect(source.calls).toHaveLength(4)

    const storageDisabled = projectRegistryApiHandlerCreate({
      repository,
      caddyApplication: caddyApplicationCreate(),
    })
    const storage = await requestJson(storageDisabled, "/api/v1/users/leo/projects/opencode/access-logs", leo)
    expect(storage.response.status).toBe(503)
    expect(storage.body).toMatchObject({
      success: false,
      error: {
        code: "access-log.unavailable",
        status: 503,
        hint: "Enable access-log storage in the daemon configuration and retry.",
      },
    })
    expect(storage.response.headers.get("cache-control")).toBe("no-store")
  })

  test("keeps real Git history clean and records one actor commit per changed API mutation", async () => {
    const directory = mkdtempSync(join(Bun.env.TMPDIR ?? "/tmp", "project-registry-api-"))
    temporaryDirectories.push(directory)
    const repositoryR = await projectRepositoryOpen({ dir: directory, branch: "main" })
    expect(repositoryR.success).toBe(true)
    if (!repositoryR.success) return
    const application = caddyApplicationCreate()
    const handler = projectRegistryApiHandlerCreate({ repository: repositoryR.data, caddyApplication: application })
    const leo = { transport: "unix", username: "leo" } as const

    const created = await requestJson(handler, "/api/v1/users/leo/projects", leo, "POST", {
      expectedRevision: "",
      name: "history-app",
      caddy: { port: 4300, domains: ["history.example"] },
    })
    expect(created.response.status).toBe(201)
    const createData = created.body.data as ProjectRepositoryMutation

    const unchanged = await requestJson(handler, "/api/v1/users/leo/projects/history-app", leo, "PATCH", {
      expectedRevision: createData.revision,
    })
    expect(unchanged.body).toMatchObject({ success: true, data: { changed: false } })

    const edited = await requestJson(handler, "/api/v1/users/leo/projects/history-app", leo, "PATCH", {
      expectedRevision: createData.revision,
      description: "changed",
    })
    expect(edited.response.status).toBe(200)
    const editData = edited.body.data as ProjectRepositoryMutation

    const deleted = await requestJson(handler, "/api/v1/users/leo/projects/history-app", leo, "DELETE", {
      expectedRevision: editData.revision,
    })
    expect(deleted.response.status).toBe(200)

    const history = await requestJson(handler, "/api/v1/users/leo/projects/history-app/history", leo)
    expect(history.response.status).toBe(200)
    const commits = history.body.data as GitStoreCommitInfo[]
    expect(commits).toHaveLength(3)
    expect(commits.map((entry) => entry.message)).toEqual([
      "project-registry delete leo/history-app actor=leo",
      "project-registry edit leo/history-app actor=leo",
      "project-registry create leo/history-app actor=leo",
    ])
    expect(application.projectChanges).toBe(3)

    const readinessR = await repositoryR.data.readiness()
    expect(readinessR).toMatchObject({ success: true, data: { ready: true, clean: true } })
  })

  test("returns deterministic errors for invalid paths, inputs, methods, and HTTP access", async () => {
    const repository = repositoryCreate()
    const handler = projectRegistryApiHandlerCreate({ repository, caddyApplication: caddyApplicationCreate() })
    const leo = { transport: "unix", username: "leo" } as const

    const unknown = await requestJson(handler, "/api/v1/users/leo/projects/opencode/extra", leo)
    expect(unknown.response.status).toBe(404)
    expect(unknown.body).toMatchObject({ success: false, error: { code: "api.not-found", status: 404 } })

    const invalidLimit = await requestJson(handler, "/history?limit=0", leo)
    expect(invalidLimit.response.status).toBe(400)
    expect(invalidLimit.body).toMatchObject({ success: false, code: "request.invalid" })

    const unsupportedRequests: Array<[string, string]> = [
      ["PUT", "/api/v1/users/leo/projects/opencode"],
      ["POST", "/projects"],
      ["POST", "/api/v1/caddy/status"],
      ["GET", "/api/v1/caddy/regenerate"],
      ["GET", "/regenerate"],
    ]
    for (const [methodName, path] of unsupportedRequests) {
      const method = await requestJson(handler, path, leo, methodName)
      expect(method.response.status).toBe(405)
      expect(method.response.headers.get("allow")).not.toBeNull()
    }

    const malformed = await handler(
      new Request("http://localhost/api/v1/users/leo/projects/opencode", { method: "PATCH", body: "{" }),
      leo,
    )
    expect(malformed.status).toBe(400)

    const readsBefore = repository.reads
    for (const path of [
      "/api/v1/users/leo/projects",
      "/api/v1/users/leo/projects/opencode",
      "/api/v1/users/leo/projects/opencode/history",
      "/api/v1/caddy/config",
      "/api/v1/caddy/status",
      "/api/v1/caddy/regenerate",
      "/projects",
      "/projects/opencode",
      "/config",
      "/history",
      "/regenerate",
    ]) {
      const method = path.endsWith("regenerate") ? "POST" : "GET"
      const denied = await requestJson(handler, path, { transport: "http" }, method)
      expect(denied.response.status).toBe(401)
    }
    expect(repository.reads).toBe(readsBefore)
  })
})
