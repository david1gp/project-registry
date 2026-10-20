import { describe, expect, test } from "bun:test"
import type { Project } from "./Project.js"
import { projectDnsPlanCreate } from "./projectDnsPlanCreate.js"

function registryProject(owner: string, name: string, domains: string[], visibility?: "public" | "private"): Project {
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
          path: "",
          access: "external",
          kind: "proxy",
          docs: false,
          browse: false,
          headerUp: {},
          disabled: false,
          denyDotfiles: false,
          spa: false,
          ...(visibility === undefined ? {} : { networkVisibility: visibility }),
        },
      },
    ],
    labels: {},
  } as unknown as Project
}

function externalProject(owner: string, name: string, domains: string[]): Project {
  const current = registryProject(owner, name, domains)
  return {
    ...current,
    services: [
      {
        id: "default",
        units: [],
        ownership: "external",
        caddy: (current.services as unknown as [{ caddy: unknown }])[0]?.caddy,
      },
    ],
  } as unknown as Project
}

describe("projectDnsPlanCreate", () => {
  test("treats absent visibility as public and separates private hostnames", () => {
    const planR = projectDnsPlanCreate([
      registryProject("leo", "app", ["app.example.com"]),
      registryProject("leo", "temp", ["temp.example.com"], "private"),
    ])
    expect(planR.success).toBe(true)
    if (!planR.success) return
    expect(planR.data.publicHostnames).toEqual(["app.example.com"])
    expect(planR.data.privateHostnames).toEqual(["temp.example.com"])
    expect(planR.data.protectedHostnames).toEqual([])
  })

  test("keeps external-service and pages.dev hostnames protected, never public or private", () => {
    const planR = projectDnsPlanCreate([
      externalProject("leo", "api", ["api.allgroups.chat"]),
      registryProject("leo", "site", ["site.pages.dev"]),
      registryProject("leo", "temp", ["site.pages.dev"], "private"),
    ])
    expect(planR.success).toBe(true)
    if (!planR.success) return
    expect(planR.data.publicHostnames).toEqual([])
    expect(planR.data.privateHostnames).toEqual([])
    expect(planR.data.protectedHostnames).toEqual(["api.allgroups.chat", "site.pages.dev"])
  })

  test("ignores disabled entries and normalizes hostnames", () => {
    const current = registryProject("leo", "app", [" App.Example.COM. "])
    const disabled = {
      ...current,
      services: [
        {
          id: "quiet",
          units: [],
          ownership: "registry",
          caddy: {
            port: 4301,
            domains: ["quiet.example.com"],
            path: "",
            access: "external",
            kind: "proxy",
            docs: false,
            browse: false,
            headerUp: {},
            disabled: true,
            denyDotfiles: false,
            spa: false,
          },
        },
      ],
    } as unknown as Project
    const planR = projectDnsPlanCreate([current, disabled])
    expect(planR.success).toBe(true)
    if (!planR.success) return
    expect(planR.data.publicHostnames).toEqual(["app.example.com"])
    expect(planR.data.privateHostnames).toEqual([])
  })

  test("rejects the same hostname claimed public and private across projects", () => {
    const planR = projectDnsPlanCreate([
      registryProject("leo", "app", ["shared.example.com"]),
      registryProject("david", "temp", ["shared.example.com"], "private"),
    ])
    expect(planR.success).toBe(false)
    if (planR.success) return
    expect(planR.errorMessage).toContain("shared.example.com")
  })

  test("rejects conflicting visibility within a single project", () => {
    const current = registryProject("leo", "app", ["shared.example.com"])
    const conflict = {
      ...current,
      services: [
        ...(current.services as unknown[]),
        {
          id: "tailnet",
          units: [],
          ownership: "registry",
          caddy: {
            port: 4301,
            domains: ["shared.example.com"],
            path: "",
            access: "external",
            kind: "proxy",
            docs: false,
            browse: false,
            headerUp: {},
            disabled: false,
            denyDotfiles: false,
            spa: false,
            networkVisibility: "private",
          },
        },
      ],
    } as unknown as Project
    const planR = projectDnsPlanCreate([conflict])
    expect(planR.success).toBe(false)
    if (planR.success) return
    expect(planR.errorMessage).toContain("shared.example.com")
  })

  test("rejects ambiguous private versus external-service ownership", () => {
    const planR = projectDnsPlanCreate([
      registryProject("david", "temp", ["shared.example.com"], "private"),
      externalProject("leo", "api", ["shared.example.com"]),
    ])
    expect(planR.success).toBe(false)
    if (planR.success) return
    expect(planR.errorMessage).toContain("shared.example.com")
  })

  test("rejects ambiguous public versus external-service ownership", () => {
    const planR = projectDnsPlanCreate([
      registryProject("leo", "app", ["shared.example.com"]),
      externalProject("david", "api", ["shared.example.com"]),
    ])
    expect(planR.success).toBe(false)
    if (planR.success) return
    expect(planR.errorMessage).toContain("shared.example.com")
  })
})
