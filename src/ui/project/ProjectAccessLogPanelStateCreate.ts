import { createRenderEffect, on, onCleanup, onMount } from "solid-js"
import { createSignalObject } from "#ui/utils/createSignalObject.js"
import { projectAccessLogClientGet } from "./projectAccessLogClientGet.js"
import type { ProjectAccessLogPage } from "./projectAccessLogPageSchema.js"
import { projectAccessLogRecordKey } from "./projectAccessLogRecordKey.js"

type VisibilityDocument = Pick<Document, "addEventListener" | "removeEventListener" | "visibilityState">
type Timer = number | ReturnType<typeof setInterval>
type ProjectAccessLogRecord = ProjectAccessLogPage["records"][number]

export function projectAccessLogPanelStateCreate(
  owner: () => string,
  name: () => string,
  dependencies: {
    client?: typeof projectAccessLogClientGet
    document?: VisibilityDocument
    intervalSet?: (handler: () => void, milliseconds: number) => Timer
    intervalClear?: (timer: Timer) => void
  } = {},
) {
  const client = dependencies.client ?? projectAccessLogClientGet
  const visibilityDocument = dependencies.document ?? document
  const intervalSet = dependencies.intervalSet ?? setInterval
  const intervalClear = dependencies.intervalClear ?? clearInterval
  const records = createSignalObject<ProjectAccessLogRecord[]>([])
  const next = createSignalObject<string | undefined>(undefined)
  const partial = createSignalObject(false)
  const malformedLines = createSignalObject(0)
  const paused = createSignalObject(false)
  const initialLoading = createSignalObject(true)
  const refreshing = createSignalObject(false)
  const olderLoading = createSignalObject(false)
  const initialErrorMessage = createSignalObject<string | undefined>(undefined)
  const expiredCursor = createSignalObject(false)
  const backgroundError = createSignalObject(false)
  const busy = () => request !== undefined
  let timer: Timer | undefined
  let request: AbortController | undefined
  let mounted = false
  let olderPagesLoaded = false

  const initialErrorMessageGet = (code?: string, statusCode?: number) => {
    if (statusCode === 404) return "Projekt nicht gefunden oder kein Zugriff."
    if (statusCode === 503 || code === "access-log.unavailable")
      return "Zugriffsprotokolle sind nicht aktiviert oder derzeit nicht verfügbar."
    if (statusCode === 400 || code === "access-log.invalid-input") return "Die Protokollanfrage ist ungültig."
    if (code === "response.malformed") return "Der Server hat eine ungültige Protokollantwort gesendet."
    return "Zugriffsprotokolle konnten nicht geladen werden."
  }

  const partialMessageGet = () => {
    if (!partial.get() && malformedLines.get() === 0) return undefined
    if (malformedLines.get() === 1) return "Ein fehlerhafter Protokolleintrag wurde übersprungen."
    return `${malformedLines.get()} fehlerhafte Protokolleinträge wurden übersprungen.`
  }

  const recordsMerge = (leading: ProjectAccessLogRecord[], trailing: ProjectAccessLogRecord[]) => {
    const seen = new Set<string>()
    const merged: ProjectAccessLogRecord[] = []
    for (const record of [...leading, ...trailing]) {
      const key = projectAccessLogRecordKey(record)
      if (seen.has(key)) continue
      seen.add(key)
      merged.push(record)
    }
    return merged
  }

  const eligibleForPolling = () => !paused.get() && visibilityDocument.visibilityState === "visible"

  const pollingStop = () => {
    if (timer === undefined) return
    intervalClear(timer)
    timer = undefined
  }

  const refresh = async (background = false) => {
    if (request !== undefined) return
    const controller = new AbortController()
    request = controller
    if (!background && !initialLoading.get()) refreshing.set(true)
    try {
      const result = await client(owner(), name(), { limit: 100, signal: controller.signal })
      if (request !== controller || !mounted) return
      initialLoading.set(false)
      refreshing.set(false)
      if (!result.success) {
        if (result.code === "request.aborted") return
        if (records.get().length > 0) {
          backgroundError.set(true)
          return
        }
        initialErrorMessage.set(initialErrorMessageGet(result.code, result.statusCode))
        return
      }
      if (background) {
        const currentTail = next.get()
        records.set(recordsMerge(result.data.records, records.get()))
        if (!olderPagesLoaded) next.set(result.data.next)
        partial.set(partial.get() || result.data.partial)
        malformedLines.set(Math.max(malformedLines.get(), result.data.malformedLines))
        if (olderPagesLoaded && currentTail !== undefined) next.set(currentTail)
      } else {
        olderPagesLoaded = false
        records.set(result.data.records)
        next.set(result.data.next)
        partial.set(result.data.partial)
        malformedLines.set(result.data.malformedLines)
      }
      initialErrorMessage.set(undefined)
      expiredCursor.set(false)
      backgroundError.set(false)
    } catch {
      if (request !== controller || !mounted) return
      initialLoading.set(false)
      refreshing.set(false)
      if (records.get().length > 0) {
        backgroundError.set(true)
        return
      }
      initialErrorMessage.set(initialErrorMessageGet())
    } finally {
      if (request === controller) {
        request = undefined
        if (mounted) refreshing.set(false)
      }
    }
  }

  const projectReset = () => {
    request?.abort()
    request = undefined
    records.set([])
    next.set(undefined)
    partial.set(false)
    malformedLines.set(0)
    olderPagesLoaded = false
    initialLoading.set(true)
    refreshing.set(false)
    olderLoading.set(false)
    initialErrorMessage.set(undefined)
    expiredCursor.set(false)
    backgroundError.set(false)
    if (mounted) void refresh()
  }

  createRenderEffect(on(() => [owner(), name()] as const, projectReset, { defer: true }))

  const pollingStart = () => {
    if (!mounted || timer !== undefined || !eligibleForPolling()) return
    timer = intervalSet(() => void refresh(true), 10_000)
  }

  const pollingSync = () => {
    if (eligibleForPolling()) {
      pollingStart()
      return
    }
    pollingStop()
  }

  const olderLoad = async () => {
    const before = next.get()
    if (before === undefined || request !== undefined) return
    const controller = new AbortController()
    request = controller
    olderLoading.set(true)
    try {
      const result = await client(owner(), name(), { limit: 100, before, signal: controller.signal })
      if (request !== controller || !mounted) return
      if (!result.success) {
        if (result.code === "request.aborted") return
        if (result.code === "access-log.cursor-expired" || result.statusCode === 410) {
          expiredCursor.set(true)
          return
        }
        backgroundError.set(true)
        return
      }
      olderPagesLoaded = true
      records.set(recordsMerge(records.get(), result.data.records))
      next.set(result.data.next)
      partial.set(partial.get() || result.data.partial)
      malformedLines.set(malformedLines.get() + result.data.malformedLines)
      expiredCursor.set(false)
      backgroundError.set(false)
    } catch {
      if (request !== controller || !mounted) return
      backgroundError.set(true)
    } finally {
      if (request === controller) {
        request = undefined
        if (mounted) olderLoading.set(false)
      }
    }
  }

  const pauseToggle = () => {
    paused.set(!paused.get())
    pollingSync()
  }

  const visibilityChange = () => pollingSync()

  const mount = () => {
    if (mounted) return
    mounted = true
    visibilityDocument.addEventListener("visibilitychange", visibilityChange)
    pollingSync()
    void refresh()
  }

  const dispose = () => {
    if (!mounted) return
    mounted = false
    visibilityDocument.removeEventListener("visibilitychange", visibilityChange)
    pollingStop()
    request?.abort()
    request = undefined
    olderPagesLoaded = false
  }

  onMount(mount)
  onCleanup(dispose)

  return {
    records: records.get,
    next: next.get,
    partial: partial.get,
    partialMessage: partialMessageGet,
    malformedLines: malformedLines.get,
    paused: paused.get,
    initialLoading: initialLoading.get,
    refreshing: refreshing.get,
    olderLoading: olderLoading.get,
    initialErrorMessage: initialErrorMessage.get,
    expiredCursor: expiredCursor.get,
    backgroundError: backgroundError.get,
    busy,
    empty: () => !initialLoading.get() && initialErrorMessage.get() === undefined && records.get().length === 0,
    refresh: () => void refresh(),
    olderLoad: () => void olderLoad(),
    pauseToggle,
    mount,
    dispose,
  }
}
