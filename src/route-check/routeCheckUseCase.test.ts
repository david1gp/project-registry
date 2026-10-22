import { describe, expect, test } from "bun:test"
import { createResult, createResultErrorCode } from "#result"
import type { ProjectAccess } from "../access/ProjectAccess.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { ProjectUseCaseOptions } from "../project/ProjectUseCaseOptions.js"
import { routeCheckProbe, type RouteCheckProbeRow } from "./routeCheckProbe.js"
import { routeCheckUseCase } from "./routeCheckUseCase.js"

const revision = "a".repeat(40)

function accessCreate(): ProjectAccess {
  return {
    actorResolve: async () => createResult({ subject: "leo-subject", username: "leo", role: "own" as const }),
    ownerRoleResolve: async () => createResult("own" as const),
  }
}

function repositoryCreate(projects: Record<string, unknown>): ProjectRepository {
  return {
    get: async (key: { owner: string; name: string }) => {
      const project = projects[`${key.owner}/${key.name}`]
      if (project === undefined) {
        return { ...createResultErrorCode("projectRepositoryGet", "project not found", "projects.not-found") }
      }
      return createResult({ project, revision })
    },
  } as unknown as ProjectRepository
}

function optionsCreate(projects: Record<string, unknown>): ProjectUseCaseOptions {
  return { repository: repositoryCreate(projects), access: accessCreate() }
}

function canonicalProject(services: unknown[]): unknown {
  return { schemaVersion: 2, owner: "leo", name: "semesterkur", services }
}

function serviceCreate(id: string, domains: string[], disabled = false): unknown {
  return { id, caddy: { port: 3225, domains, disabled } }
}

function probeCreate(rows: Record<string, Omit<RouteCheckProbeRow, "hostname">>): typeof routeCheckProbe {
  return async (hostname) => {
    const row = rows[hostname]
    if (row === undefined) throw new Error(`unexpected probe for ${hostname}`)
    return createResult({ ...row, hostname })
  }
}

describe("routeCheckUseCase", () => {
  test("probes every served service domain and attributes rows per service", async () => {
    const options = optionsCreate({
      "leo/semesterkur": canonicalProject([
        serviceCreate("convex-preview", ["semesterkur-convex.leonardomora.de"]),
        serviceCreate("api-preview", ["semesterkur-api.leonardomora.de"]),
      ]),
    })
    const probe = probeCreate({
      "semesterkur-convex.leonardomora.de": {
        addresses: ["100.122.200.114"],
        tls: { authorized: true, validTo: null, issuer: null },
        httpStatus: 200,
        httpMs: 11,
        ok: true,
        error: null,
      },
      "semesterkur-api.leonardomora.de": {
        addresses: ["100.122.200.114"],
        tls: { authorized: true, validTo: null, issuer: null },
        httpStatus: 404,
        httpMs: 9,
        ok: true,
        error: null,
      },
    })
    const result = await routeCheckUseCase(options, { owner: "leo", name: "semesterkur" }, { probe })
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.errorMessage)
    expect(result.data.rows).toHaveLength(2)
    expect(result.data.rows[0]).toMatchObject({ service: "convex-preview", httpStatus: 200, ok: true })
    expect(result.data.rows[1]).toMatchObject({ service: "api-preview", httpStatus: 404, ok: true })
  })

  test("limits probing to the requested service", async () => {
    const options = optionsCreate({
      "leo/semesterkur": canonicalProject([
        serviceCreate("convex-preview", ["semesterkur-convex.leonardomora.de"]),
        serviceCreate("api-preview", ["semesterkur-api.leonardomora.de"]),
      ]),
    })
    const probed: string[] = []
    const probe: typeof routeCheckProbe = async (hostname) => {
      probed.push(hostname)
      return createResult({
        hostname,
        addresses: ["100.122.200.114"],
        tls: { authorized: true, validTo: null, issuer: null },
        httpStatus: 200,
        httpMs: 1,
        ok: true,
        error: null,
      })
    }
    const result = await routeCheckUseCase(
      options,
      { owner: "leo", name: "semesterkur", service: "convex-preview" },
      { probe },
    )
    expect(result.success).toBe(true)
    if (!result.success) throw new Error(result.errorMessage)
    expect(probed).toEqual(["semesterkur-convex.leonardomora.de"])
    expect(result.data.rows).toHaveLength(1)
  })

  test("fails closed on an unknown service instead of checking everything", async () => {
    const options = optionsCreate({
      "leo/semesterkur": canonicalProject([serviceCreate("convex-preview", ["semesterkur-convex.leonardomora.de"])]),
    })
    let probed = 0
    const probe: typeof routeCheckProbe = async (hostname) => {
      probed += 1
      return createResult({
        hostname,
        addresses: [],
        tls: null,
        httpStatus: null,
        httpMs: null,
        ok: false,
        error: "unreachable",
      })
    }
    const result = await routeCheckUseCase(options, { owner: "leo", name: "semesterkur", service: "nope" }, { probe })
    expect(result.success).toBe(false)
    expect(probed).toBe(0)
  })

  test("skips disabled services and propagates unknown projects", async () => {
    const options = optionsCreate({
      "leo/semesterkur": canonicalProject([
        serviceCreate("convex-preview", ["semesterkur-convex.leonardomora.de"], true),
      ]),
    })
    const probe = probeCreate({})
    const empty = await routeCheckUseCase(options, { owner: "leo", name: "semesterkur" }, { probe })
    expect(empty.success).toBe(true)
    if (!empty.success) throw new Error(empty.errorMessage)
    expect(empty.data.rows).toEqual([])
    const missing = await routeCheckUseCase(options, { owner: "leo", name: "missing" }, { probe })
    expect(missing.success).toBe(false)
  })
})
