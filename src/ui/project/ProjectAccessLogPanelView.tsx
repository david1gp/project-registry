import type { JSX } from "solid-js"
import { Show } from "solid-js"
import { Button } from "#ui/interactive/button/Button.jsx"
import { Badge } from "#ui/static/badge/Badge.jsx"
import { CardWrapper } from "#ui/static/card/CardWrapper.jsx"
import { CodeBlock } from "#ui/static/code/CodeBlock.jsx"
import { LoaderSpin4Square } from "#ui/static/loaders/LoaderSpin4Square.jsx"
import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"
import { Table1R } from "#ui/table/table1/Table1R.jsx"
import type { projectAccessLogPanelStateCreate } from "./ProjectAccessLogPanelStateCreate.js"
import type { ProjectAccessLogPage } from "./projectAccessLogPageSchema.js"
import { projectAccessLogRecordSummary } from "./projectAccessLogRecordSummary.js"
import { projectAccessLogTimestampFormat } from "./projectAccessLogTimestampFormat.js"

type ProjectAccessLogRecord = ProjectAccessLogPage["records"][number]
type ProjectAccessLogPanelState = ReturnType<typeof projectAccessLogPanelStateCreate>

const columns: TableColumnDef<ProjectAccessLogRecord>[] = [
  {
    id: "timestamp",
    name: "Zeit",
    cell: (record) => {
      const timestamp = projectAccessLogRecordSummary(record).timestamp
      return timestamp === undefined ? "—" : projectAccessLogTimestampFormat(timestamp)
    },
  },
  { id: "method", name: "Methode", cell: (record) => projectAccessLogRecordSummary(record).method ?? "—" },
  { id: "host", name: "Host", cell: (record) => projectAccessLogRecordSummary(record).host ?? "—" },
  { id: "path", name: "Pfad", cell: (record) => projectAccessLogRecordSummary(record).path ?? "—" },
  {
    id: "status",
    name: "Status",
    cell: (record) => {
      const status = projectAccessLogRecordSummary(record).status
      if (status === undefined) return "—"
      return (
        <Badge variant={status >= 500 ? "filledRed" : status >= 400 ? "filledYellow" : "filledGreen"}>{status}</Badge>
      )
    },
  },
  {
    id: "duration",
    name: "Dauer",
    cell: (record) => {
      const duration = projectAccessLogRecordSummary(record).duration
      return duration === undefined ? "—" : `${Math.round(duration * 1_000)} ms`
    },
  },
  {
    id: "responseBytes",
    name: "Bytes",
    cell: (record) => projectAccessLogRecordSummary(record).responseBytes?.toLocaleString("de-DE") ?? "—",
  },
  {
    id: "clientNetwork",
    name: "Client",
    cell: (record) => projectAccessLogRecordSummary(record).clientNetwork ?? "—",
  },
  {
    id: "rawRecord",
    name: "JSON",
    cell: (record) => (
      <details>
        <summary class="cursor-pointer font-medium text-blue-700 dark:text-blue-300">JSON anzeigen</summary>
        <CodeBlock class="mt-2 max-h-96 min-w-80 overflow-auto text-left" data={record} />
      </details>
    ),
  },
]

export function ProjectAccessLogPanelView(p: { state: ProjectAccessLogPanelState; titleId: string }): JSX.Element {
  return (
    <CardWrapper class="flex flex-col gap-4" aria-labelledby={p.titleId}>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={p.titleId} class="text-xl font-semibold">
            Zugriffsprotokoll
          </h2>
          <p class="text-sm text-slate-600 dark:text-slate-300">Neueste Anfragen für dieses Projekt.</p>
        </div>
        <div class="flex gap-2">
          <Button variant="outline" onClick={p.state.refresh} disabled={p.state.busy()}>
            {p.state.refreshing() ? "Wird aktualisiert …" : "Aktualisieren"}
          </Button>
          <Button variant="outline" onClick={p.state.pauseToggle} aria-pressed={p.state.paused()}>
            {p.state.paused() ? "Fortsetzen" : "Pausieren"}
          </Button>
        </div>
      </div>
      <p class="sr-only" role="status" aria-live="polite">
        {p.state.initialLoading()
          ? "Protokolle werden geladen."
          : p.state.refreshing()
            ? "Protokolle werden aktualisiert."
            : p.state.olderLoading()
              ? "Ältere Protokolle werden geladen."
              : ""}
      </p>
      <div aria-busy={p.state.busy()}>
        <Show when={p.state.initialLoading()}>
          <div class="flex items-center gap-3 py-6" role="status">
            <LoaderSpin4Square class="h-6 w-6" /> Protokolle werden geladen …
          </div>
        </Show>
        <Show when={p.state.initialErrorMessage()} keyed>
          {(message) => (
            <p class="rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-100" role="alert">
              {message}
            </p>
          )}
        </Show>
        <Show when={p.state.empty()}>
          <p class="py-6 text-center text-slate-600 dark:text-slate-300">Noch keine Zugriffe vorhanden.</p>
        </Show>
        <Show when={p.state.backgroundError()}>
          <p class="rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="status">
            Die Aktualisierung ist fehlgeschlagen. Vorhandene Einträge bleiben sichtbar.
          </p>
        </Show>
        <Show when={p.state.expiredCursor()}>
          <p class="rounded-md bg-amber-50 p-3 text-amber-900 dark:bg-amber-950 dark:text-amber-100" role="alert">
            Ältere Einträge können nicht mehr geladen werden, weil der Cursor abgelaufen ist. Bitte aktualisieren Sie
            die Liste.
          </p>
        </Show>
        <Show when={p.state.partialMessage()} keyed>
          {(message) => (
            <div class="flex items-center gap-2" role="status">
              <Badge variant="filledYellow">Teilweise Daten</Badge>
              <span>{message}</span>
            </div>
          )}
        </Show>
        <Show when={p.state.records().length > 0}>
          <section class="overflow-x-auto" aria-labelledby={p.titleId}>
            <Table1R rows={p.state.records()} columns={columns} />
          </section>
        </Show>
        <Show when={p.state.next() !== undefined && !p.state.expiredCursor()}>
          <Button variant="outline" onClick={p.state.olderLoad} disabled={p.state.busy()}>
            {p.state.olderLoading() ? "Ältere werden geladen …" : "Ältere laden"}
          </Button>
        </Show>
      </div>
    </CardWrapper>
  )
}
