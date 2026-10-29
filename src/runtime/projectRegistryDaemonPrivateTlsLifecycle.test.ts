import { describe, expect, test } from "bun:test"
import * as a from "valibot"
import { createResult } from "#result"
import type { Project } from "../project/Project.js"
import { projectRegistryDaemonPrivateTlsCreate } from "./projectRegistryDaemonPrivateTlsCreate.js"
import { projectRegistryDaemonPrivateTlsStatusSchema } from "./projectRegistryDaemonPrivateTlsStatusSchema.js"

function project(name: string, domains: string[], owner = "leo"): Project {
  return {
    schemaVersion: 2,
    owner,
    name,
    order: 0,
    services: [
      {
        id: "default",
        units: [],
        ownership: "registry",
        caddy: {
          port: 4300,
          domains,
          path: "/srv/app",
          access: "external",
          kind: "proxy",
          docs: true,
          browse: false,
          headerUp: {},
          disabled: false,
          denyDotfiles: false,
          spa: false,
          networkVisibility: "private",
        },
      },
    ],
    labels: {},
  }
}

function timerCreate(): {
  timer: { setInterval(callback: () => void, delayMs: number): unknown; clearInterval(handle: unknown): void }
  tick(): void
} {
  const callbacks: Array<() => void> = []
  return {
    timer: {
      setInterval(callback) {
        callbacks.push(callback)
        return callback
      },
      clearInterval() {},
    },
    tick() {
      callbacks[0]?.()
    },
  }
}

async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) {
    await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0))
  }
}

describe("projectRegistryDaemonPrivateTls lifecycle", () => {
  test("enrolls multi-level hosts with the claiming owner's token and skips wildcard-covered names", async () => {
    const timer = timerCreate()
    const asked: string[] = []
    const logs: string[] = []
    let projects: Project[] = []
    const queueR = projectRegistryDaemonPrivateTlsCreate({
      enabled: true,
      credentialResolve: async (owner) => {
        asked.push(owner)
        return createResult(`${owner}-token`)
      },
      repositoryProjectsCurrent: async () => createResult(projects),
      logger: (message) => logs.push(message),
      timer: timer.timer,
    })
    expect(queueR.success).toBe(true)
    if (!queueR.success) return
    expect(queueR.data.start().success).toBe(true)

    const first = project("app", ["checkout.wonder1.de", "api.preview.wonder1.de"])
    projects = [first]
    queueR.data.projectCreateAfterPersistence(first)
    await settle()

    const status = queueR.data.status()
    expect(status.enrolled).toEqual(["api.preview.wonder1.de"])
    expect(status.wildcardCovered).toEqual(["checkout.wonder1.de"])
    expect(status.pendingOwners).toBe(0)
    expect(status.errors).toEqual([])
    expect(status.challengeResolvers).toEqual(["1.1.1.1", "8.8.8.8"])
    expect(status.lastSuccess).toBeDefined()
    // The token funds exactly one claiming-owner lookup; the wildcard name triggers none.
    expect(asked).toEqual(["leo"])
    expect(JSON.stringify([...logs, status])).not.toContain("leo-token")

    queueR.data.projectDeleteAfterPersistence(first)
    projects = []
    await settle()
    expect(queueR.data.status().enrolled).toEqual([])
    expect(queueR.data.status().wildcardCovered).toEqual([])
    await queueR.data.shutdown()
  })

  test("missing claiming-owner token defers with retry and recovers without touching other owners", async () => {
    let now = 2_000_000
    const timer = timerCreate()
    const tokens = new Map<string, string | undefined>([["leo", undefined]])
    const projects = [project("app", ["api.preview.wonder1.de"])]
    const queueR = projectRegistryDaemonPrivateTlsCreate({
      enabled: true,
      credentialResolve: async (owner) => createResult(tokens.get(owner)),
      repositoryProjectsCurrent: async () => createResult(projects),
      clock: () => now,
      timer: timer.timer,
    })
    if (!queueR.success) throw new Error("setup failed")
    expect(queueR.data.start().success).toBe(true)
    queueR.data.projectCreateAfterPersistence(projects[0]!)
    await settle()

    let status = queueR.data.status()
    expect(status.enrolled).toEqual([])
    expect(status.pendingOwners).toBe(1)
    expect(status.errors).toHaveLength(1)
    expect(status.errors[0]).toMatchObject({ owner: "leo", operation: "tls-token" })
    expect(status.errors[0]?.errorMessage).toContain('owner "leo"')
    expect(status.errors[0]?.nextRetryAt).toBe(now + 2_000)

    tokens.set("leo", "leo-token")
    now += 2_001
    timer.tick()
    await settle()
    status = queueR.data.status()
    expect(status.enrolled).toEqual(["api.preview.wonder1.de"])
    expect(status.pendingOwners).toBe(0)
    expect(status.errors).toEqual([])
    expect(status.lastSuccess).toBe(now)
    await queueR.data.shutdown()
  })

  test("surfaces claim rejections persistently and releases renamed hosts", async () => {
    const timer = timerCreate()
    let projects: Project[] = []
    const queueR = projectRegistryDaemonPrivateTlsCreate({
      enabled: true,
      credentialResolve: async (owner) => createResult(`${owner}-token`),
      repositoryProjectsCurrent: async () => createResult(projects),
      timer: timer.timer,
    })
    if (!queueR.success) throw new Error("setup failed")
    expect(queueR.data.start().success).toBe(true)

    const foreign = project("app", ["api.preview.wonder1.de"], "fabian")
    projects = [foreign]
    queueR.data.projectCreateAfterPersistence(foreign)
    await settle()
    let status = queueR.data.status()
    expect(status.enrolled).toEqual([])
    expect(status.errors).toHaveLength(1)
    expect(status.errors[0]).toMatchObject({ owner: "fabian", operation: "claim" })
    expect(status.errors[0]?.errorMessage).toContain("webflows.de")

    const renamed = project("app", ["api.preview.sales.wonder1.de"])
    projects = [renamed]
    queueR.data.projectEditAfterPersistence(foreign, renamed)
    await settle()
    status = queueR.data.status()
    expect(status.enrolled).toEqual(["api.preview.sales.wonder1.de"])
    expect(status.errors).toEqual([])
    await queueR.data.shutdown()
  })

  test("stays idle while disabled and refuses the private listener as a challenge resolver", async () => {
    let calls = 0
    const disabledR = projectRegistryDaemonPrivateTlsCreate({
      enabled: false,
      credentialResolve: async () => {
        calls += 1
        return createResult("token")
      },
      repositoryProjectsCurrent: async () => createResult([project("app", ["api.preview.wonder1.de"])]),
      timer: timerCreate().timer,
    })
    expect(disabledR.success).toBe(true)
    if (!disabledR.success) return
    expect(disabledR.data.start().success).toBe(true)
    await settle()
    expect(disabledR.data.status().enrolled).toEqual([])
    expect(calls).toBe(0)
    await disabledR.data.shutdown()

    const listenerR = projectRegistryDaemonPrivateTlsCreate({
      enabled: true,
      challengeResolvers: ["1.1.1.1", "100.122.200.114"],
      privateListenerAddresses: ["100.122.200.114"],
      timer: timerCreate().timer,
    })
    expect(listenerR.success).toBe(false)
  })

  test("status validates against the published schema", async () => {
    const queueR = projectRegistryDaemonPrivateTlsCreate({
      enabled: true,
      credentialResolve: async () => createResult(undefined),
      repositoryProjectsCurrent: async () => createResult([project("app", ["api.preview.wonder1.de"])]),
      timer: timerCreate().timer,
    })
    if (!queueR.success) throw new Error("setup failed")
    expect(queueR.data.start().success).toBe(true)
    await settle()
    const parsed = a.safeParse(projectRegistryDaemonPrivateTlsStatusSchema, queueR.data.status())
    expect(parsed.success).toBe(true)
    await queueR.data.shutdown()
  })
})
