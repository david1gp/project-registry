import { describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { TailscaleSplitDnsFetch } from "../tailscale/TailscaleSplitDnsFetch.js"
import { projectRegistryCliArgumentsParse } from "./projectRegistryCliArgumentsParse.js"
import { projectRegistryCliHelp } from "./projectRegistryCliHelp.js"
import { projectRegistryCliRun } from "./projectRegistryCliRun.js"
import { projectRegistryCliSplitDnsRollback } from "./projectRegistryCliSplitDnsRollback.js"

const nodeAddress = "100.122.200.114"
const environment = { TAILSCALE_TAILNET: "example.com", TAILSCALE_API_KEY: "tskey-api-secret" }

function stateFileContent(applied: Record<string, string[] | null>, prior: Record<string, string[] | null>): string {
  return JSON.stringify({
    version: 1,
    tailnet: "example.com",
    nodeAddress,
    savedAt: "2026-10-29T00:00:00.000Z",
    prior,
    applied,
  })
}

function fetchCreate(map: Record<string, string[]>, bodies: unknown[]): TailscaleSplitDnsFetch {
  const live = new Map(Object.entries(map))
  return (async (input: string, init: RequestInit): Promise<Response> => {
    const url = new URL(String(input))
    if (!url.pathname.endsWith("/dns/split-dns")) return new Response("not found", { status: 404 })
    if ((init.method ?? "GET") === "GET") {
      return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
    }
    const body = JSON.parse(init.body as string) as Record<string, string[] | null>
    bodies.push(body)
    for (const [hostname, value] of Object.entries(body)) {
      if (value === null) live.delete(hostname)
      else live.set(hostname, value)
    }
    return new Response(JSON.stringify(Object.fromEntries(live)), { status: 200 })
  }) as TailscaleSplitDnsFetch
}

describe("tailscale split-dns rollback arguments", () => {
  test("parses --state-file and --owner/--state-dir selectors", () => {
    const byFile = projectRegistryCliArgumentsParse([
      "tailscale",
      "split-dns",
      "rollback",
      "--state-file",
      "/var/lib/leo.split-dns.json",
    ])
    expect(byFile.success).toBe(true)
    if (!byFile.success) return
    expect(byFile.data.command).toEqual({
      kind: "tailscale-split-dns-rollback",
      stateFile: "/var/lib/leo.split-dns.json",
    })

    const byOwner = projectRegistryCliArgumentsParse([
      "tailscale",
      "split-dns",
      "rollback",
      "--owner",
      "leo",
      "--state-dir",
      "/var/lib/project-registry",
      "--json",
    ])
    expect(byOwner.success).toBe(true)
    if (!byOwner.success) return
    expect(byOwner.data.command).toEqual({
      kind: "tailscale-split-dns-rollback",
      owner: "leo",
      stateDir: "/var/lib/project-registry",
    })
    expect(byOwner.data.json).toBe(true)
  })

  test("rejects missing, combined, and unrelated selectors", () => {
    expect(projectRegistryCliArgumentsParse(["tailscale", "split-dns", "rollback"]).success).toBe(false)
    expect(projectRegistryCliArgumentsParse(["tailscale", "split-dns", "rollback", "--owner", "leo"]).success).toBe(
      false,
    )
    expect(
      projectRegistryCliArgumentsParse([
        "tailscale",
        "split-dns",
        "rollback",
        "--state-file",
        "/tmp/state.json",
        "--owner",
        "leo",
      ]).success,
    ).toBe(false)
    expect(
      projectRegistryCliArgumentsParse([
        "tailscale",
        "split-dns",
        "rollback",
        "--state-file",
        "/tmp/state.json",
        "--port",
        "8080",
      ]).success,
    ).toBe(false)
    expect(
      projectRegistryCliArgumentsParse(["tailscale", "split-dns", "rollback", "extra", "--state-file", "/tmp/s"])
        .success,
    ).toBe(false)
  })

  test("rejects the rollback selectors on unrelated commands", () => {
    expect(projectRegistryCliArgumentsParse(["status", "--state-file", "/tmp/s"]).success).toBe(false)
    expect(projectRegistryCliArgumentsParse(["project", "list", "--state-dir", "/tmp"]).success).toBe(false)
  })

  test("help documents the rollback command", () => {
    expect(projectRegistryCliHelp).toContain("tailscale split-dns rollback")
    expect(projectRegistryCliHelp).toContain("TAILSCALE_API_KEY")
  })
})

describe("projectRegistryCliSplitDnsRollback", () => {
  test("restores from an explicit state file via PATCH", async () => {
    const bodies: unknown[] = []
    const result = await projectRegistryCliSplitDnsRollback({
      stateFile: "/var/lib/leo.split-dns.json",
      environment,
      stateRead: async () => stateFileContent({ "new.wonder1.de": [nodeAddress] }, { "new.wonder1.de": ["9.9.9.9"] }),
      fetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, bodies),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.data).toEqual({ stateFile: "/var/lib/leo.split-dns.json", restored: ["new.wonder1.de"] })
    expect(bodies).toEqual([{ "new.wonder1.de": ["9.9.9.9"] }])
    expect(JSON.stringify(result)).not.toContain("tskey-api-secret")
  })

  test("derives the per-owner state file from --owner/--state-dir", async () => {
    const read: string[] = []
    const result = await projectRegistryCliSplitDnsRollback({
      owner: "leo",
      stateDir: "/var/lib/project-registry",
      environment,
      stateRead: async (path) => {
        read.push(path)
        return stateFileContent({}, {})
      },
      fetch: fetchCreate({}, []),
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(read).toEqual(["/var/lib/project-registry/leo.split-dns.json"])
    expect(result.data.restored).toEqual([])
  })

  test("refuses tailnet mismatch, external changes, and unsafe owners without leaking the key", async () => {
    const foreign = await projectRegistryCliSplitDnsRollback({
      stateFile: "/tmp/state.json",
      environment: { ...environment, TAILSCALE_TAILNET: "other.example" },
      stateRead: async () => stateFileContent({ "new.wonder1.de": [nodeAddress] }, {}),
      fetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, []),
    })
    expect(foreign.success).toBe(false)

    const changed = await projectRegistryCliSplitDnsRollback({
      stateFile: "/tmp/state.json",
      environment,
      stateRead: async () => stateFileContent({ "new.wonder1.de": [nodeAddress] }, {}),
      fetch: fetchCreate({ "new.wonder1.de": ["9.9.9.9"] }, []),
    })
    expect(changed.success).toBe(false)
    if (!changed.success) expect(changed.errorMessage).toContain("changed externally")

    const unsafe = await projectRegistryCliSplitDnsRollback({
      owner: "../root",
      stateDir: "/var/lib",
      environment,
      stateRead: async () => "",
      fetch: fetchCreate({}, []),
    })
    expect(unsafe.success).toBe(false)

    const missingTailnet = await projectRegistryCliSplitDnsRollback({
      stateFile: "/tmp/state.json",
      environment: { TAILSCALE_API_KEY: "tskey-api-secret" },
    })
    expect(missingTailnet.success).toBe(false)

    const missingKey = await projectRegistryCliSplitDnsRollback({
      stateFile: "/tmp/state.json",
      environment: { TAILSCALE_TAILNET: "example.com" },
    })
    expect(missingKey.success).toBe(false)

    for (const outcome of [foreign, changed, unsafe, missingTailnet, missingKey]) {
      expect(JSON.stringify(outcome)).not.toContain("tskey-api-secret")
    }
  })
})

describe("projectRegistryCliRun tailscale split-dns rollback", () => {
  test("runs locally without a daemon socket and prints restored entries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "split-dns-rollback-"))
    try {
      const stateFile = join(directory, "leo.split-dns.json")
      await writeFile(stateFile, stateFileContent({ "new.wonder1.de": [nodeAddress] }, {}))
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await projectRegistryCliRun(
        ["tailscale", "split-dns", "rollback", "--owner", "leo", "--state-dir", directory],
        {
          environment: { ...environment },
          tailscaleFetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, []),
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        },
      )
      expect(exitCode).toBe(0)
      expect(stderr).toEqual([])
      expect(stdout).toEqual([`restored new.wonder1.de from ${stateFile}\n`])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  test("emits the JSON envelope and reports refusals as errors", async () => {
    const directory = await mkdtemp(join(tmpdir(), "split-dns-rollback-"))
    try {
      const stateFile = join(directory, "leo.split-dns.json")
      await writeFile(stateFile, stateFileContent({ "new.wonder1.de": [nodeAddress] }, {}))
      const stdout: string[] = []
      const stderr: string[] = []
      const exitCode = await projectRegistryCliRun(
        ["tailscale", "split-dns", "rollback", "--state-file", stateFile, "--json"],
        {
          environment: { ...environment },
          tailscaleFetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, []),
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        },
      )
      expect(exitCode).toBe(0)
      expect(JSON.parse(stdout.join(""))).toEqual({
        success: true,
        data: { stateFile, restored: ["new.wonder1.de"] },
      })

      const refusedOut: string[] = []
      const refusedErr: string[] = []
      const refusedCode = await projectRegistryCliRun(
        ["tailscale", "split-dns", "rollback", "--state-file", stateFile],
        {
          environment: { ...environment, TAILSCALE_TAILNET: "other.example" },
          tailscaleFetch: fetchCreate({ "new.wonder1.de": [nodeAddress] }, []),
          stdout: (text) => refusedOut.push(text),
          stderr: (text) => refusedErr.push(text),
        },
      )
      expect(refusedCode).toBe(1)
      expect(refusedOut).toEqual([])
      expect(refusedErr.join("")).toContain("another tailnet")
      expect(refusedErr.join("")).not.toContain("tskey-api-secret")
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
