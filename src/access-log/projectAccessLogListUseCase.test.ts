import { describe, expect, test } from "bun:test"
import { createResult, createResultError, createResultErrorCode, type Result } from "#result"
import { caddyAccessLogFixture } from "../../test/fixtures/caddyAccessLogFixture.js"
import type { Actor } from "../access/Actor.js"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { Role } from "../access/Role.js"
import type { Project } from "../project/Project.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectAccessLogPage, ProjectAccessLogSource } from "./ProjectAccessLogSource.js"
import { projectAccessLogListUseCase } from "./projectAccessLogListUseCase.js"

const revision = "a".repeat(40)

function project(owner: string, name: string, disabled = false): Project {
  return {
    schemaVersion: 1,
    owner,
    name,
    type: "customer",
    order: 0,
    services: [],
    caddy: {
      port: 3000,
      domains: [`${name}.example`],
      path: "",
      access: "external",
      kind: "proxy",
      docs: true,
      browse: false,
      headerUp: {},
      disabled,
      denyDotfiles: false,
      spa: false,
    },
  }
}

function repositoryCreate(
  value: Project | undefined,
  failure?: ReturnType<typeof createResultError>,
): ProjectRepository {
  return {
    get: async () => {
      if (failure !== undefined) return failure
      if (value === undefined)
        return createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found")
      return createResult({ project: value, revision })
    },
  } as unknown as ProjectRepository
}

function accessCreate(actor: Actor, ownerRole: Role | undefined): ProjectAccess {
  return {
    actorResolve: async () => createResult(actor),
    ownerRoleResolve: async () => createResult(ownerRole),
  }
}

function sourceCreate(result: Result<ProjectAccessLogPage>): ProjectAccessLogSource & {
  calls: number
} {
  const source = {
    calls: 0,
    read: async () => {
      source.calls += 1
      return result
    },
  } as ProjectAccessLogSource & { calls: number }
  return source
}

const page: ProjectAccessLogPage = {
  records: [caddyAccessLogFixture],
  next: undefined,
  partial: false,
  malformedLines: 0,
}

describe("projectAccessLogListUseCase", () => {
  test("reuses the project read role matrix before reading storage", async () => {
    const cases: readonly [Role, string, Role | undefined, boolean][] = [
      ["own", "alice", "own", true],
      ["own", "bob", "own", false],
      ["admin", "bob", "own", true],
      ["admin", "bob", "admin", true],
      ["admin", "bob", "superadmin", false],
      ["superadmin", "bob", undefined, true],
    ]

    for (const [actorRole, owner, ownerRole, allowed] of cases) {
      const source = sourceCreate(createResult(page))
      const result = await projectAccessLogListUseCase(
        {
          repository: repositoryCreate(project(owner, "site")),
          access: accessCreate({ subject: "s", username: "alice", role: actorRole }, ownerRole),
          source,
        },
        { owner, name: "site" },
      )
      expect(result.success).toBe(allowed)
      expect(source.calls).toBe(allowed ? 1 : 0)
    }
  })

  test("passes the complete raw source page through unchanged", async () => {
    const source = sourceCreate(createResult(page))
    const result = await projectAccessLogListUseCase(
      {
        repository: repositoryCreate(project("alice", "site")),
        access: accessCreate({ subject: "s", username: "alice", role: "own" }, "own"),
        source,
      },
      { owner: "alice", name: "site" },
    )

    expect(result).toEqual(createResult(page))
  })

  test("collapses missing and unauthorized projects to the same safe result", async () => {
    const missing = await projectAccessLogListUseCase(
      {
        repository: repositoryCreate(undefined),
        access: accessCreate({ subject: "s", username: "alice", role: "superadmin" }, undefined),
      },
      { owner: "bob", name: "site" },
    )
    const unauthorized = await projectAccessLogListUseCase(
      {
        repository: repositoryCreate(project("bob", "site")),
        access: accessCreate({ subject: "s", username: "alice", role: "own" }, "own"),
      },
      { owner: "bob", name: "site" },
    )

    expect(missing).toEqual(unauthorized)
    expect(missing).toMatchObject({ success: false, code: "access-log.not-found" })
  })

  test("does not infer inaccessible projects from unstructured repository messages", async () => {
    const result = await projectAccessLogListUseCase(
      {
        repository: repositoryCreate(
          project("alice", "site"),
          createResultError("projectRepositoryGet", "project not found"),
        ),
        access: accessCreate({ subject: "s", username: "alice", role: "own" }, "own"),
      },
      { owner: "alice", name: "site" },
    )

    expect(result).toMatchObject({ success: false, code: "access-log.unavailable" })
  })

  test.each([undefined, true])("does not read disabled, catalog-only, or disabled storage", async (disabled) => {
    const source = sourceCreate(createResult(page))
    const result = await projectAccessLogListUseCase(
      {
        repository: repositoryCreate(
          disabled === undefined ? { ...project("alice", "catalog"), caddy: null } : project("alice", "site", disabled),
        ),
        access: accessCreate({ subject: "s", username: "alice", role: "own" }, "own"),
        source,
      },
      { owner: "alice", name: disabled === undefined ? "catalog" : "site" },
    )

    expect(result).toMatchObject({ success: false, code: "access-log.unavailable" })
    expect(source.calls).toBe(0)
  })

  test("maps unavailable storage and bounds paging input", async () => {
    const source = sourceCreate({
      ...createResultError("projectAccessLogSourceFile", "log storage is unavailable"),
      code: "access-log.storage-unavailable",
    } as unknown as Result<ProjectAccessLogPage>)
    const options = {
      repository: repositoryCreate(project("alice", "site")),
      access: accessCreate({ subject: "s", username: "alice", role: "own" }, "own"),
      source,
    }

    expect(await projectAccessLogListUseCase(options, { owner: "alice", name: "site" }, { limit: 0 })).toMatchObject({
      success: false,
      code: "access-log.invalid-input",
    })
    expect(
      await projectAccessLogListUseCase(options, { owner: "alice", name: "site" }, { limit: 1_001 }),
    ).toMatchObject({
      success: false,
      code: "access-log.invalid-input",
    })
    expect(await projectAccessLogListUseCase(options, { owner: "alice", name: "site" })).toMatchObject({
      success: false,
      code: "access-log.storage-unavailable",
    })
  })
})
