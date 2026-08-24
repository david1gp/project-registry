import { describe, expect, test } from "bun:test"
import type { GitStoreCommitInfo } from "#git-store"
import { createResult, createResultError, type Result } from "#result"
import type { Actor } from "../access/Actor.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { Role } from "../access/Role.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectRepositoryMutation } from "../project-store/ProjectRepositoryMutation.js"
import type { Project } from "./Project.js"
import type { ProjectMutationOptions } from "./ProjectMutationOptions.js"
import type { ProjectUseCaseOptions } from "./ProjectUseCaseOptions.js"
import { projectCreate } from "./projectCreate.js"
import { projectDelete } from "./projectDelete.js"
import { projectEdit } from "./projectEdit.js"
import { projectGetUseCase } from "./projectGetUseCase.js"
import { projectHistory } from "./projectHistory.js"
import type { ProjectKey } from "./projectKey.js"
import { projectListUseCase } from "./projectListUseCase.js"

const currentRevision = "a".repeat(40)
const staleRevision = "b".repeat(40)
const nextRevision = "c".repeat(40)

type RepositoryFake = ProjectRepository & {
  calls: {
    create: { project: unknown; options: ProjectMutationOptions & { actor: string } }[]
    edit: { key: ProjectKey; project: unknown; options: ProjectMutationOptions & { actor: string } }[]
    delete: { key: ProjectKey; options: ProjectMutationOptions & { actor: string } }[]
    history: { key: ProjectKey | undefined; limit: number | undefined }[]
    ownerHistory: { owner: string; limit: number | undefined }[]
  }
  revision: string
  projects: Project[]
  readResult?: Result<{ projects: Project[]; revision: string }>
  getResult?: Result<{ project: Project; revision: string }>
  mutationResult?: Result<ProjectRepositoryMutation>
  historyResult?: Result<GitStoreCommitInfo[]>
}

function project(owner: string, name: string, port?: number, disabled = false): Project {
  return {
    schemaVersion: 1,
    owner,
    name,
    type: "customer",
    order: Number.MAX_SAFE_INTEGER,
    services: [],
    labels: {},
    ...(port === undefined
      ? {}
      : {
          caddy: {
            port,
            domains: [`${name}.${owner}.example`],
            path: "",
            access: "external" as const,
            kind: "proxy" as const,
            docs: true,
            browse: false,
            headerUp: {},
            disabled,
            denyDotfiles: false,
            spa: false,
          },
        }),
  }
}

function mutation(action: ProjectRepositoryMutation["action"], key: ProjectKey): ProjectRepositoryMutation {
  return {
    action,
    key,
    changed: true,
    revision: nextRevision,
    localCommit: { status: "committed", revision: nextRevision },
    push: { requested: true, status: "failed", errorMessage: "push unavailable" },
  }
}

function repositoryCreate(initialProjects: Project[] = []): RepositoryFake {
  const repository = {} as RepositoryFake
  repository.projects = [...initialProjects]
  repository.revision = currentRevision
  repository.calls = { create: [], edit: [], delete: [], history: [], ownerHistory: [] }
  repository.read = async () => {
    if (repository.readResult !== undefined) return repository.readResult
    return createResult({ projects: repository.projects, revision: repository.revision })
  }
  repository.get = async (key) => {
    if (repository.getResult !== undefined) return repository.getResult
    const found = repository.projects.find((item) => item.owner === key.owner && item.name === key.name)
    if (!found) return createResultError("fakeGet", "project not found")
    return createResult({ project: found, revision: repository.revision })
  }
  repository.create = async (newProject, options) => {
    repository.calls.create.push({ project: newProject, options })
    if (repository.mutationResult !== undefined) return repository.mutationResult
    const value = newProject as Project
    repository.projects.push(value)
    return createResult(mutation("create", value))
  }
  repository.edit = async (key, newProject, options) => {
    repository.calls.edit.push({ key, project: newProject, options })
    if (repository.mutationResult !== undefined) return repository.mutationResult
    const index = repository.projects.findIndex((item) => item.owner === key.owner && item.name === key.name)
    if (index < 0) return createResultError("fakeEdit", "project not found")
    repository.projects[index] = newProject as Project
    return createResult(mutation("edit", key))
  }
  repository.delete = async (key, options) => {
    repository.calls.delete.push({ key, options })
    if (repository.mutationResult !== undefined) return repository.mutationResult
    const index = repository.projects.findIndex((item) => item.owner === key.owner && item.name === key.name)
    if (index < 0) return createResultError("fakeDelete", "project not found")
    repository.projects.splice(index, 1)
    return createResult(mutation("delete", key))
  }
  repository.history = async (key, limit) => {
    repository.calls.history.push({ key, limit })
    if (repository.historyResult !== undefined) return repository.historyResult
    return createResult([])
  }
  repository.ownerHistory = async (owner, limit) => {
    repository.calls.ownerHistory.push({ owner, limit })
    if (repository.historyResult !== undefined) return repository.historyResult
    return createResult([])
  }
  repository.readiness = async () => createResult({ ready: true, clean: true, revision: repository.revision })
  repository.recover = async () => createResult({ ready: true, clean: true, revision: repository.revision })
  return repository
}

type AccessFake = ProjectAccess & {
  ownerCalls: string[]
  actorCalls: number
  actorResult?: Result<Actor>
  ownerResult?: Result<Role | undefined>
}

function accessCreate(actor: Actor, ownerRoles: Record<string, Role | undefined> = {}): AccessFake {
  const access: AccessFake = {
    ownerCalls: [] as string[],
    actorCalls: 0,
    actorResolve: async (): Promise<Result<Actor>> => {
      access.actorCalls += 1
      return access.actorResult ?? createResult(actor)
    },
    ownerRoleResolve: async (owner: string): Promise<Result<Role | undefined>> => {
      access.ownerCalls.push(owner)
      return access.ownerResult ?? createResult(ownerRoles[owner])
    },
  }
  return access
}

function useCaseOptions(repository: RepositoryFake, access: ProjectAccess, portRange?: { from: number; to: number }) {
  return { repository, access, portRange } satisfies ProjectUseCaseOptions
}

describe("project use cases", () => {
  test("lists only projects visible under current owner roles and returns the registry revision", async () => {
    const repository = repositoryCreate([
      project("carol", "superadmin-project", 3002),
      project("bob", "admin-project", 3001),
      project("alice", "own-project", 3000),
    ])
    const access = accessCreate(
      { subject: "admin-subject", username: "alice", role: "admin" },
      { alice: "own", bob: "admin", carol: "superadmin" },
    )

    const result = await projectListUseCase(useCaseOptions(repository, access))

    expect(result).toMatchObject({
      success: true,
      data: { revision: currentRevision, projects: [{ owner: "bob" }, { owner: "alice" }] },
    })
    expect(access.ownerCalls).toEqual(["alice", "carol", "bob"])
  })

  test("enforces own, admin, and superadmin project boundaries for targeted reads", async () => {
    const repository = repositoryCreate([project("alice", "mine"), project("bob", "other")])
    const ownAccess = accessCreate({ subject: "own-subject", username: "alice", role: "own" }, { bob: "own" })
    const ownResult = await projectListUseCase(useCaseOptions(repository, ownAccess), { owner: "bob" })
    expect(ownResult.success).toBe(false)

    const adminAccess = accessCreate({ subject: "admin-subject", username: "alice", role: "admin" }, { bob: "admin" })
    const adminResult = await projectGetUseCase(useCaseOptions(repository, adminAccess), {
      owner: "bob",
      name: "other",
    })
    expect(adminResult.success).toBe(true)

    const superadminAccess = accessCreate(
      { subject: "superadmin-subject", username: "root", role: "superadmin" },
      { orphan: undefined },
    )
    const superadminResult = await projectGetUseCase(useCaseOptions(repository, superadminAccess), {
      owner: "orphan",
      name: "missing",
    })
    expect(superadminResult.success).toBe(false)
    if (superadminResult.success) return
    expect(superadminResult.errorMessage).toBe("project not found")
  })

  test("propagates access and repository failures for get and list", async () => {
    const repository = repositoryCreate([project("alice", "catalog")])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })
    access.ownerResult = createResultError("ownerRoleResolve", "role directory unavailable")

    const accessFailure = await projectGetUseCase(useCaseOptions(repository, access), {
      owner: "alice",
      name: "catalog",
    })
    expect(accessFailure).toMatchObject({ success: false, errorMessage: "role directory unavailable" })

    access.ownerResult = undefined
    repository.readResult = createResultError("fakeRead", "repository unavailable")
    const repositoryFailure = await projectListUseCase(useCaseOptions(repository, access))
    expect(repositoryFailure).toMatchObject({ success: false, errorMessage: "repository unavailable" })
  })

  test("creates a normalized project, allocates the lowest available port, and preserves push state", async () => {
    const repository = repositoryCreate([project("bob", "existing", 3000)])
    const access = accessCreate({ subject: "admin-subject", username: "alice", role: "admin" }, { bob: "admin" })

    const result = await projectCreate(
      useCaseOptions(repository, access, { from: 3000, to: 3002 }),
      {
        owner: " bob ",
        name: "new-project",
        type: " CUSTOMER ",
        services: [" api.service ", "api.service"],
        caddy: { domains: [" New.Example. "] },
      },
      { expectedRevision: currentRevision },
    )

    expect(result).toMatchObject({
      success: true,
      data: {
        localCommit: { status: "committed" },
        push: { requested: true, status: "failed", errorMessage: "push unavailable" },
      },
    })
    expect(repository.calls.create[0]).toMatchObject({
      options: { actor: "alice", expectedRevision: currentRevision },
      project: { owner: "bob", services: ["api.service"], caddy: { port: 3001, domains: ["new.example"] } },
    })
  })

  test("edits complete registry state without changing owner/name and propagates stale revisions", async () => {
    const repository = repositoryCreate([project("alice", "catalog", 3000), project("bob", "other", 3001)])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })

    const immutableResult = await projectEdit(
      useCaseOptions(repository, access, { from: 3000, to: 3002 }),
      { owner: "alice", name: "catalog" },
      { owner: "alice", name: "renamed", caddy: { domains: ["new.example"] } },
      { expectedRevision: currentRevision },
    )
    expect(immutableResult).toMatchObject({ success: false, errorMessage: "project owner and name are immutable" })
    expect(repository.calls.edit).toHaveLength(0)

    const current = repository.projects[0]
    if (!current?.caddy) return
    repository.projects[0] = {
      ...current,
      caddy: { ...current.caddy, headerUp: { "X-Old": "old", "X-Keep": "keep" } },
    }
    repository.mutationResult = createResultError("fakeEdit", "revision mismatch")
    const staleResult = await projectEdit(
      useCaseOptions(repository, access, { from: 3000, to: 3002 }),
      { owner: "alice", name: "catalog" },
      { description: "updated", caddy: { domains: ["new.example"], headerUp: { "X-New": "new" } } },
      { expectedRevision: staleRevision },
    )
    expect(staleResult).toMatchObject({ success: false, errorMessage: "revision mismatch" })
    expect(repository.calls.edit[0]).toMatchObject({
      key: { owner: "alice", name: "catalog" },
      options: { actor: "alice", expectedRevision: staleRevision },
      project: {
        owner: "alice",
        name: "catalog",
        caddy: {
          port: 3000,
          headerUp: { "X-Old": "old", "X-Keep": "keep", "X-New": "new" },
        },
      },
    })
  })

  test("replaces labels only when labels are included in an edit", async () => {
    const repository = repositoryCreate([project("alice", "catalog")])
    repository.projects[0] = { ...repository.projects[0]!, labels: { team: "platform", tier: "gold" } }
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })

    const preserveResult = await projectEdit(
      useCaseOptions(repository, access),
      { owner: "alice", name: "catalog" },
      { description: "updated" },
      { expectedRevision: currentRevision },
    )
    expect(preserveResult.success).toBe(true)
    expect(repository.calls.edit[0]?.project).toMatchObject({ labels: { team: "platform", tier: "gold" } })

    const replaceResult = await projectEdit(
      useCaseOptions(repository, access),
      { owner: "alice", name: "catalog" },
      { labels: { team: "core" } },
      { expectedRevision: currentRevision },
    )
    expect(replaceResult.success).toBe(true)
    expect(repository.calls.edit[1]?.project).toMatchObject({ labels: { team: "core" } })
    const replacement = repository.calls.edit[1]
    expect(replacement).toBeDefined()
    if (replacement === undefined) return
    expect((replacement.project as Project).labels).toEqual({ team: "core" })
  })

  test("propagates not-found and role failures for delete and history", async () => {
    const repository = repositoryCreate([project("alice", "catalog")])
    const access = accessCreate({ subject: "admin-subject", username: "admin", role: "admin" }, { alice: "own" })

    const notFoundResult = await projectDelete(
      useCaseOptions(repository, access),
      { owner: "alice", name: "missing" },
      { expectedRevision: currentRevision },
    )
    expect(notFoundResult).toMatchObject({ success: false, errorMessage: "project not found" })
    expect(repository.calls.delete).toHaveLength(0)

    repository.mutationResult = createResultError("fakeDelete", "repository unavailable")
    const repositoryFailure = await projectDelete(
      useCaseOptions(repository, access),
      { owner: "alice", name: "catalog" },
      { expectedRevision: staleRevision },
    )
    expect(repositoryFailure).toMatchObject({ success: false, errorMessage: "repository unavailable" })
    expect(repository.calls.delete[0]).toMatchObject({
      options: { actor: "admin", expectedRevision: staleRevision },
    })

    repository.mutationResult = undefined
    repository.historyResult = createResultError("fakeHistory", "history unavailable")
    const historyFailure = await projectHistory(
      useCaseOptions(repository, access),
      { owner: "alice", name: "catalog" },
      10,
    )
    expect(historyFailure).toMatchObject({ success: false, errorMessage: "history unavailable" })
    expect(repository.calls.history).toEqual([{ key: { owner: "alice", name: "catalog" }, limit: 10 }])

    access.ownerResult = createResultError("ownerRoleResolve", "owner removed")
    const roleFailure = await projectHistory(useCaseOptions(repository, access), { owner: "alice", name: "catalog" })
    expect(roleFailure).toMatchObject({ success: false, errorMessage: "owner removed" })
    expect(repository.calls.history).toHaveLength(1)
  })

  test("requires an explicit expected revision before any mutation call", async () => {
    const repository = repositoryCreate([project("alice", "catalog"), project("alice", "other")])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })
    const missing = undefined as unknown as ProjectMutationOptions

    const createResult = await projectCreate(
      useCaseOptions(repository, access),
      {
        owner: "alice",
        name: "new-project",
      },
      missing,
    )
    const editResult = await projectEdit(
      useCaseOptions(repository, access),
      { owner: "alice", name: "catalog" },
      { description: "updated" },
      missing,
    )
    const deleteResult = await projectDelete(
      useCaseOptions(repository, access),
      { owner: "alice", name: "other" },
      missing,
    )

    for (const result of [createResult, editResult, deleteResult]) {
      expect(result).toMatchObject({ success: false, errorMessage: "expectedRevision must be a non-empty string" })
    }
    expect(repository.calls.create).toHaveLength(0)
    expect(repository.calls.edit).toHaveLength(0)
    expect(repository.calls.delete).toHaveLength(0)

    const blankResult = await projectCreate(
      useCaseOptions(repository, access),
      { owner: "alice", name: "blank-revision" },
      { expectedRevision: " " },
    )
    expect(blankResult).toMatchObject({ success: false, errorMessage: "expectedRevision must be a non-empty string" })
    expect(repository.calls.create).toHaveLength(0)
  })

  test("rejects malformed expected and current revisions without calling the repository mutation", async () => {
    const repository = repositoryCreate([project("alice", "catalog")])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })
    const malformedExpectedRevisions: unknown[] = [
      undefined,
      null,
      1,
      " ",
      "",
      "not-a-revision",
      "A".repeat(40),
      ` ${currentRevision}`,
      `${currentRevision} `,
    ]

    for (const expectedRevision of malformedExpectedRevisions) {
      const result = await projectCreate(
        useCaseOptions(repository, access),
        { owner: "alice", name: "invalid-revision" },
        { expectedRevision } as unknown as ProjectMutationOptions,
      )
      expect(result.success).toBe(false)
    }

    for (const currentRevisionValue of [undefined, null, 1, " ", "\t"]) {
      repository.readResult = createResult({
        projects: repository.projects,
        revision: currentRevisionValue,
      } as unknown as { projects: Project[]; revision: string })
      const result = await projectCreate(
        useCaseOptions(repository, access),
        { owner: "alice", name: "invalid-current-revision" },
        { expectedRevision: currentRevision },
      )
      expect(result.success).toBe(false)
    }

    expect(repository.calls.create).toHaveLength(0)
  })

  test("accepts only the exact empty revision for an empty initial repository", async () => {
    const repository = repositoryCreate()
    repository.revision = ""
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })

    const whitespace = await projectCreate(
      useCaseOptions(repository, access),
      { owner: "alice", name: "whitespace" },
      { expectedRevision: " " },
    )
    expect(whitespace.success).toBe(false)

    const initial = await projectCreate(
      useCaseOptions(repository, access),
      { owner: "alice", name: "initial" },
      { expectedRevision: "" },
    )
    expect(initial.success).toBe(true)
  })

  test("rejects create and edit collisions before mutation and does not reserve disabled projects", async () => {
    const repository = repositoryCreate([
      project("alice", "catalog", 3002),
      project("bob", "active", 3000),
      project("bob", "disabled", 3001, true),
    ])
    const access = accessCreate(
      { subject: "admin-subject", username: "admin", role: "admin" },
      { alice: "admin", bob: "admin" },
    )
    const options = useCaseOptions(repository, access, { from: 3001, to: 3001 })

    const createCollision = await projectCreate(
      options,
      { owner: "alice", name: "create-collision", caddy: { port: 3000, domains: ["new.example"] } },
      { expectedRevision: currentRevision },
    )
    expect(createCollision.success).toBe(false)
    if (createCollision.success) return
    expect(createCollision.errorMessage).toContain("active port collision")
    expect(repository.calls.create).toHaveLength(0)

    const editCollision = await projectEdit(
      options,
      { owner: "alice", name: "catalog" },
      { caddy: { port: 3000, domains: ["catalog-new.example"] } },
      { expectedRevision: currentRevision },
    )
    expect(editCollision.success).toBe(false)
    if (editCollision.success) return
    expect(editCollision.errorMessage).toContain("active port collision")
    expect(repository.calls.edit).toHaveLength(0)

    const disabledResult = await projectCreate(
      options,
      { owner: "alice", name: "disabled-compatible", caddy: { domains: ["disabled.bob.example"] } },
      { expectedRevision: currentRevision },
    )
    expect(disabledResult.success).toBe(true)
    expect(repository.calls.create).toHaveLength(1)
    expect(repository.calls.create[0]?.project).toMatchObject({
      owner: "alice",
      name: "disabled-compatible",
      caddy: { port: 3001, domains: ["disabled.bob.example"] },
    })
  })

  test("allows superadmins to see and operate unresolved owners while non-superadmins cannot", async () => {
    const orphan = project("orphan", "catalog")
    const superadminAccess = accessCreate({ subject: "root-subject", username: "root", role: "superadmin" })
    const superadminListRepository = repositoryCreate([orphan])
    const superadminList = await projectListUseCase(useCaseOptions(superadminListRepository, superadminAccess))
    expect(superadminList).toMatchObject({ success: true, data: { projects: [{ owner: "orphan", name: "catalog" }] } })

    const superadminEditRepository = repositoryCreate([orphan])
    const superadminEdit = await projectEdit(
      useCaseOptions(superadminEditRepository, superadminAccess),
      { owner: "orphan", name: "catalog" },
      { description: "recovered" },
      { expectedRevision: currentRevision },
    )
    expect(superadminEdit.success).toBe(true)
    expect(superadminEditRepository.calls.edit).toHaveLength(1)

    const superadminDeleteRepository = repositoryCreate([orphan])
    const superadminDelete = await projectDelete(
      useCaseOptions(superadminDeleteRepository, superadminAccess),
      { owner: "orphan", name: "catalog" },
      { expectedRevision: currentRevision },
    )
    expect(superadminDelete.success).toBe(true)
    expect(superadminDeleteRepository.calls.delete).toHaveLength(1)

    const history = [{ sha: "orphan-revision", date: "2026-08-17T00:00:00.000Z", author: "root", message: "recover" }]
    const superadminHistoryRepository = repositoryCreate([orphan])
    superadminHistoryRepository.historyResult = createResult(history)
    const superadminHistory = await projectHistory(
      useCaseOptions(superadminHistoryRepository, superadminAccess),
      { owner: "orphan", name: "catalog" },
      5,
    )
    expect(superadminHistory).toEqual(createResult(history))

    const nonSuperadminAccess = accessCreate(
      { subject: "admin-subject", username: "admin", role: "admin" },
      { admin: "admin" },
    )
    const nonSuperadminRepository = repositoryCreate([orphan])
    const nonSuperadminList = await projectListUseCase(useCaseOptions(nonSuperadminRepository, nonSuperadminAccess))
    expect(nonSuperadminList).toMatchObject({ success: true, data: { projects: [] } })

    const nonSuperadminEdit = await projectEdit(
      useCaseOptions(nonSuperadminRepository, nonSuperadminAccess),
      { owner: "orphan", name: "catalog" },
      { description: "hidden" },
      { expectedRevision: currentRevision },
    )
    const nonSuperadminDelete = await projectDelete(
      useCaseOptions(nonSuperadminRepository, nonSuperadminAccess),
      { owner: "orphan", name: "catalog" },
      { expectedRevision: currentRevision },
    )
    const nonSuperadminHistory = await projectHistory(useCaseOptions(nonSuperadminRepository, nonSuperadminAccess), {
      owner: "orphan",
      name: "catalog",
    })
    for (const result of [nonSuperadminEdit, nonSuperadminDelete, nonSuperadminHistory]) {
      expect(result).toMatchObject({ success: false, errorMessage: "project owner current role is unavailable" })
    }
    expect(nonSuperadminRepository.calls.edit).toHaveLength(0)
    expect(nonSuperadminRepository.calls.delete).toHaveLength(0)
    expect(nonSuperadminRepository.calls.history).toHaveLength(0)
  })

  test("does not pollute prototypes while merging malicious patch keys", async () => {
    const repository = repositoryCreate([project("alice", "catalog", 3000)])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })
    const patch = JSON.parse(
      '{"description":"safe","__proto__":{"polluted":"root"},"constructor":{"polluted":"constructor"},"prototype":{"polluted":"prototype"},"caddy":{"domains":["new.example"],"unknown":{"polluted":"nested"},"__proto__":{"polluted":"nested-proto"},"constructor":{"polluted":"nested-constructor"},"prototype":{"polluted":"nested-prototype"}}}',
    )

    const result = await projectEdit(useCaseOptions(repository, access), { owner: "alice", name: "catalog" }, patch, {
      expectedRevision: currentRevision,
    })

    expect(result.success).toBe(true)
    expect(Object.hasOwn(Object.prototype, "polluted")).toBe(false)
    const edited = repository.calls.edit[0]?.project
    expect(edited).toMatchObject({ description: "safe", caddy: { domains: ["new.example"] } })
    expect(edited && typeof edited === "object" ? Object.hasOwn(edited, "__proto__") : false).toBe(false)
    expect(edited && typeof edited === "object" ? Object.hasOwn(edited, "constructor") : false).toBe(false)
    expect(edited && typeof edited === "object" ? Object.hasOwn(edited, "prototype") : false).toBe(false)
    const caddy = edited && typeof edited === "object" ? (edited as Record<string, unknown>).caddy : undefined
    expect(caddy && typeof caddy === "object" ? Object.hasOwn(caddy, "unknown") : false).toBe(false)
    expect(caddy && typeof caddy === "object" ? Object.hasOwn(caddy, "__proto__") : false).toBe(false)
  })

  test("returns successful gets and preserves repository get failures", async () => {
    const projectValue = project("alice", "catalog")
    const repository = repositoryCreate([projectValue])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })
    const entry = { project: projectValue, revision: nextRevision }
    repository.getResult = createResult(entry)

    const success = await projectGetUseCase(useCaseOptions(repository, access), { owner: "alice", name: "catalog" })
    expect(success).toEqual(createResult(entry))

    const failure = createResultError("fakeGet", "repository get unavailable")
    repository.getResult = failure
    const failed = await projectGetUseCase(useCaseOptions(repository, access), { owner: "alice", name: "catalog" })
    expect(failed).toEqual(failure)
  })

  test("preserves the exact commit and push result for create, edit, and delete", async () => {
    const repository = repositoryCreate([project("alice", "edit"), project("alice", "delete")])
    const access = accessCreate({ subject: "alice-subject", username: "alice", role: "own" }, { alice: "own" })
    const createMutation: ProjectRepositoryMutation = {
      action: "create",
      key: { owner: "alice", name: "create" },
      changed: true,
      revision: nextRevision,
      localCommit: { status: "committed", revision: nextRevision },
      push: { requested: true, status: "pushed" },
    }
    const editMutation: ProjectRepositoryMutation = {
      action: "edit",
      key: { owner: "alice", name: "edit" },
      changed: true,
      revision: nextRevision,
      localCommit: { status: "committed", revision: nextRevision },
      push: { requested: true, status: "failed", errorMessage: "push unavailable" },
    }
    const deleteMutation: ProjectRepositoryMutation = {
      action: "delete",
      key: { owner: "alice", name: "delete" },
      changed: true,
      revision: nextRevision,
      localCommit: { status: "committed", revision: nextRevision },
      push: { requested: false, status: "not-requested" },
    }

    repository.mutationResult = createResult(createMutation)
    const createResultValue = await projectCreate(
      useCaseOptions(repository, access),
      { owner: "alice", name: "create" },
      { expectedRevision: currentRevision },
    )
    expect(createResultValue).toEqual(createResult(createMutation))

    repository.mutationResult = createResult(editMutation)
    const editResultValue = await projectEdit(
      useCaseOptions(repository, access),
      { owner: "alice", name: "edit" },
      { description: "updated" },
      { expectedRevision: currentRevision },
    )
    expect(editResultValue).toEqual(createResult(editMutation))

    repository.mutationResult = createResult(deleteMutation)
    const deleteResultValue = await projectDelete(
      useCaseOptions(repository, access),
      { owner: "alice", name: "delete" },
      { expectedRevision: currentRevision },
    )
    expect(deleteResultValue).toEqual(createResult(deleteMutation))
  })
})
