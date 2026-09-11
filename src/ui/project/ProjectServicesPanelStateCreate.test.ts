import { describe, expect, test } from "bun:test"
import { createRoot } from "solid-js"
import { createResult, createResultError } from "#result"
import { createSignalObject } from "#ui/utils/createSignalObject.js"
import { projectServicesPanelStateCreate } from "./ProjectServicesPanelStateCreate.js"
import type { ProjectServices, ProjectServicesService } from "./projectServicesSchema.js"

const caddy: NonNullable<ProjectServicesService["caddy"]> = {
  port: 3000,
  domains: ["app.example"],
  path: "",
  access: "external",
  kind: "proxy",
  docs: true,
  browse: false,
  disabled: false,
  spa: false,
  denyDotfiles: false,
  headerUp: {},
}

const services: ProjectServicesService[] = [
  { id: "default", units: [], caddy: { ...caddy } },
  { id: "api", units: [], caddy: { ...caddy, port: 3001, domains: ["api.example"] } },
]

function project(): ProjectServices {
  return { schemaVersion: 2, owner: "leo", name: "app", labels: {}, services }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

function searchParamsCreate() {
  const values = new Map<string, string>()
  return {
    values,
    get: (key: string) => values.get(key),
    set: (key: string, value?: string) => {
      if (value === undefined) values.delete(key)
      else values.set(key, value)
    },
  }
}

describe("projectServicesPanelStateCreate", () => {
  test("lists every canonical service of the project", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const state = projectServicesPanelStateCreate(
          () => "leo",
          () => "app",
          { client: async () => createResult({ project: project(), revision: "r1" }) },
        )
        await settle()
        expect(state.loading()).toBe(false)
        expect(state.services().map((service) => service.id)).toEqual(["default", "api"])
        expect(state.revision()).toBe("r1")
        dispose()
        resolve()
      })
    })
  })

  test("saves one edited service while preserving siblings and tracks the editor in search params", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const searchParams = searchParamsCreate()
        const patches: unknown[] = []
        const state = projectServicesPanelStateCreate(
          () => "leo",
          () => "app",
          {
            client: async () => createResult({ project: project(), revision: "r1" }),
            patchClient: async (_owner, _name, input) => {
              patches.push(input)
              return createResult({ revision: "r2", changed: true })
            },
            searchParams,
          },
        )
        await settle()

        state.editorOpen("api")
        expect(searchParams.values.get("service")).toBe("api")
        expect(state.draft()?.port).toBe("3001")

        state.draftFieldSet("port", "3009")
        state.save()
        await settle()

        expect(patches).toHaveLength(1)
        expect((patches[0] as { expectedRevision: string }).expectedRevision).toBe("r1")
        const saved = (patches[0] as { services: ProjectServicesService[] }).services
        expect(saved[0]?.caddy?.port).toBe(3000)
        expect(saved[1]?.caddy?.port).toBe(3009)
        expect(state.revision()).toBe("r2")
        expect(searchParams.values.has("service")).toBe(false)
        dispose()
        resolve()
      })
    })
  })

  test("opens the editor from an initial service query parameter and follows query changes", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const searchParams = searchParamsCreate()
        searchParams.values.set("service", "api")
        const serviceId = createSignalObject<string | undefined>("api")
        const state = projectServicesPanelStateCreate(
          () => "leo",
          () => "app",
          {
            client: async () => createResult({ project: project(), revision: "r1" }),
            searchParams: { get: () => serviceId.get(), set: (_key, value) => serviceId.set(value) },
          },
        )
        await settle()

        expect(state.draft()?.id).toBe("api")
        expect(state.draft()?.port).toBe("3001")

        serviceId.set("default")
        await settle()
        expect(state.draft()?.id).toBe("default")
        expect(state.draft()?.port).toBe("3000")

        serviceId.set(undefined)
        await settle()
        expect(state.draft()).toBeUndefined()
        dispose()
        resolve()
      })
    })
  })

  test("surfaces a collision error from the API and keeps the editor open", async () => {
    await new Promise<void>((resolve) => {
      createRoot(async (dispose) => {
        const state = projectServicesPanelStateCreate(
          () => "leo",
          () => "app",
          {
            client: async () => createResult({ project: project(), revision: "r1" }),
            patchClient: async () => ({
              ...createResultError("test", "active port collision: 3001"),
              code: "projects.conflict",
              statusCode: 409,
            }),
          },
        )
        await settle()
        state.editorOpen("api")
        state.save()
        await settle()

        expect(state.errorMessage()).toBe("active port collision: 3001")
        expect(state.draft()).toBeDefined()
        expect(state.saving()).toBe(false)
        dispose()
        resolve()
      })
    })
  })
})
