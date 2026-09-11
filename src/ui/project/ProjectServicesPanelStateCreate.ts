import { createRenderEffect, on, onCleanup, onMount } from "solid-js"
import { createSignalObject } from "#ui/utils/createSignalObject.js"
import { projectServiceDraftApply } from "./projectServiceDraftApply.js"
import { projectServiceDraftFrom } from "./projectServiceDraftFrom.js"
import type { ProjectServiceDraft } from "./projectServiceDraftSchema.js"
import { projectServicesClientGet } from "./projectServicesClientGet.js"
import { projectServicesClientPatch } from "./projectServicesClientPatch.js"
import type { ProjectServicesService } from "./projectServicesSchema.js"

type ProjectServicesSearchParams = {
  get: (key: string) => string | undefined
  set: (key: string, value?: string) => void
}

const noSearchParams: ProjectServicesSearchParams = { get: () => undefined, set: () => {} }

export function projectServicesPanelStateCreate(
  owner: () => string,
  name: () => string,
  dependencies: {
    client?: typeof projectServicesClientGet
    patchClient?: typeof projectServicesClientPatch
    searchParams?: ProjectServicesSearchParams
  } = {},
) {
  const client = dependencies.client ?? projectServicesClientGet
  const patchClient = dependencies.patchClient ?? projectServicesClientPatch
  const searchParams = dependencies.searchParams ?? noSearchParams

  const services = createSignalObject<ProjectServicesService[]>([])
  const revision = createSignalObject("")
  const loading = createSignalObject(true)
  const saving = createSignalObject(false)
  const errorMessage = createSignalObject<string | undefined>(undefined)
  const errorHint = createSignalObject<string | undefined>(undefined)
  const draft = createSignalObject<ProjectServiceDraft | undefined>(undefined)
  let mounted = false
  let request: AbortController | undefined

  const load = async () => {
    request?.abort()
    const controller = new AbortController()
    request = controller
    try {
      const result = await client(owner(), name(), { signal: controller.signal })
      if (request !== controller || !mounted) return
      loading.set(false)
      if (!result.success) {
        if (result.code === "request.aborted") return
        errorMessage.set(result.errorMessage)
        errorHint.set(result.hint ?? "Aktualisieren Sie die Seite und versuchen Sie es erneut.")
        return
      }
      services.set(result.data.project.services)
      revision.set(result.data.revision)
      errorMessage.set(undefined)
      errorHint.set(undefined)
    } finally {
      if (request === controller) request = undefined
    }
  }

  const editorServiceId = () => searchParams.get("service")

  const editorOpen = (serviceId: string) => {
    const service = services.get().find((candidate) => candidate.id === serviceId)
    draft.set(projectServiceDraftFrom(service, serviceId))
    searchParams.set("service", serviceId)
  }

  const editorClose = () => {
    draft.set(undefined)
    searchParams.set("service", undefined)
  }

  const draftFieldSet = (field: keyof ProjectServiceDraft, value: string | boolean) => {
    const current = draft.get()
    if (current === undefined) return
    draft.set({ ...current, [field]: value })
  }

  const save = async () => {
    const current = draft.get()
    if (current === undefined || saving.get()) return
    const appliedR = projectServiceDraftApply(services.get(), current)
    if (!appliedR.success) {
      errorMessage.set(appliedR.errorMessage)
      errorHint.set("Prüfen Sie Port und Domains des Dienstes.")
      return
    }
    saving.set(true)
    try {
      const result = await patchClient(owner(), name(), {
        services: appliedR.data,
        expectedRevision: revision.get(),
      })
      if (!mounted) return
      if (!result.success) {
        errorMessage.set(result.errorMessage)
        errorHint.set(result.hint ?? "Prüfen Sie Port- und Domain-Kollisionen und versuchen Sie es erneut.")
        return
      }
      services.set(appliedR.data)
      revision.set(result.data.revision)
      errorMessage.set(undefined)
      errorHint.set(undefined)
      editorClose()
    } finally {
      if (mounted) saving.set(false)
    }
  }

  /** Service id from the URL that still waits for the service list to load. */
  let pendingServiceId: string | undefined

  const draftSetFrom = (serviceId: string) => {
    const service = services.get().find((candidate) => candidate.id === serviceId)
    pendingServiceId = service === undefined ? serviceId : undefined
    draft.set(projectServiceDraftFrom(service, serviceId))
  }

  /** Opens the editor for a deep-linked or externally changed `service` query parameter. */
  createRenderEffect(
    on(editorServiceId, (serviceId) => {
      if (serviceId === undefined) {
        pendingServiceId = undefined
        draft.set(undefined)
        return
      }
      if (draft.get()?.id === serviceId && pendingServiceId === undefined) return
      draftSetFrom(serviceId)
    }),
  )

  createRenderEffect(
    on(
      services.get,
      () => {
        if (pendingServiceId === undefined) return
        draftSetFrom(pendingServiceId)
      },
      { defer: true },
    ),
  )

  createRenderEffect(
    on(
      () => [owner(), name()] as const,
      () => {
        services.set([])
        revision.set("")
        loading.set(true)
        errorMessage.set(undefined)
        errorHint.set(undefined)
        draft.set(undefined)
        if (mounted) void load()
      },
      { defer: true },
    ),
  )

  onMount(() => {
    mounted = true
    void load()
  })
  onCleanup(() => {
    mounted = false
    request?.abort()
    request = undefined
  })

  return {
    services: services.get,
    revision: revision.get,
    loading: loading.get,
    saving: saving.get,
    errorMessage: errorMessage.get,
    errorHint: errorHint.get,
    empty: () => !loading.get() && errorMessage.get() === undefined && services.get().length === 0,
    draft: draft.get,
    editorServiceId,
    editorOpen,
    editorClose,
    draftFieldSet,
    save: () => void save(),
    refresh: () => void load(),
  }
}
