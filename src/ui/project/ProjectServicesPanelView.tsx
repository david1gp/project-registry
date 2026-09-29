import type { JSX } from "solid-js"
import { Show } from "solid-js"
import { classesInput } from "#ui/input/input/classesInput.js"
import { Input } from "#ui/input/input/Input.jsx"
import { Label } from "#ui/input/label/Label.jsx"
import { Button } from "#ui/interactive/button/Button.jsx"
import { Badge } from "#ui/static/badge/Badge.jsx"
import { CardWrapper } from "#ui/static/card/CardWrapper.jsx"
import { LoaderSpin4Square } from "#ui/static/loaders/LoaderSpin4Square.jsx"
import type { TableColumnDef } from "#ui/table/shared/TableColumnDef.js"
import { Table1R } from "#ui/table/table1/Table1R.jsx"
import type { projectServicesPanelStateCreate } from "./ProjectServicesPanelStateCreate.js"
import type { ProjectServicesService } from "./projectServicesSchema.js"

type ProjectServicesPanelState = ReturnType<typeof projectServicesPanelStateCreate>

function columnsCreate(state: ProjectServicesPanelState): TableColumnDef<ProjectServicesService>[] {
  return [
    { id: "id", name: "Dienst", cell: (service) => service.id },
    { id: "port", name: "Port", cell: (service) => service.caddy?.port ?? "—" },
    {
      id: "domains",
      name: "Domains",
      cell: (service) => (service.caddy === null ? "—" : service.caddy.domains.join(", ")),
    },
    { id: "kind", name: "Art", cell: (service) => service.caddy?.kind ?? "—" },
    { id: "access", name: "Zugriff", cell: (service) => service.caddy?.access ?? "—" },
    {
      id: "status",
      name: "Status",
      cell: (service) => (
        <Badge variant={service.caddy === null || service.caddy.disabled ? "filledYellow" : "filledGreen"}>
          {service.caddy === null ? "Kein Caddy" : service.caddy.disabled ? "Deaktiviert" : "Aktiv"}
        </Badge>
      ),
    },
    { id: "units", name: "Units", cell: (service) => (service.units.length === 0 ? "—" : service.units.join(", ")) },
    {
      id: "actions",
      name: "Aktion",
      cell: (service) => (
        <Button variant="outline" onClick={() => state.editorOpen(service.id)}>
          Bearbeiten
        </Button>
      ),
    },
  ]
}

export function ProjectServicesPanelView(p: { state: ProjectServicesPanelState; titleId: string }): JSX.Element {
  return (
    <CardWrapper class="flex flex-col gap-4" aria-labelledby={p.titleId}>
      <div class="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id={p.titleId} class="text-xl font-semibold">
            Dienste
          </h2>
          <p class="text-sm text-slate-600 dark:text-slate-300">
            Alle Dienste dieses Projekts mit eigener Domain, eigenem Port und eigenen Caddy-Einstellungen.
          </p>
        </div>
        <div class="flex gap-2">
          <Button onClick={p.state.editorNewOpen} disabled={p.state.saving()}>
            Dienst hinzufügen
          </Button>
          <Button variant="outline" onClick={p.state.refresh} disabled={p.state.saving()}>
            Aktualisieren
          </Button>
        </div>
      </div>
      <div aria-busy={p.state.loading() || p.state.saving()}>
        <Show when={p.state.loading()}>
          <div class="flex items-center gap-3 py-6" role="status">
            <LoaderSpin4Square class="h-6 w-6" /> Dienste werden geladen …
          </div>
        </Show>
        <Show when={p.state.errorMessage()} keyed>
          {(message) => (
            <div class="rounded-md bg-red-50 p-3 text-red-800 dark:bg-red-950 dark:text-red-100" role="alert">
              <p>{message}</p>
              <Show when={p.state.errorHint()} keyed>
                {(hint) => <p class="mt-1">{hint}</p>}
              </Show>
              <Button class="mt-2" variant="outline" onClick={p.state.refresh}>
                Erneut versuchen
              </Button>
            </div>
          )}
        </Show>
        <Show when={p.state.empty()}>
          <p class="py-6 text-center text-slate-600 dark:text-slate-300">Dieses Projekt hat noch keine Dienste.</p>
        </Show>
        <Show when={p.state.services().length > 0}>
          <section class="overflow-x-auto" aria-labelledby={p.titleId}>
            <Table1R rows={p.state.services()} columns={columnsCreate(p.state)} />
          </section>
        </Show>
        <Show when={p.state.draft()}>
          {(draft) => (
            <form
              class="mt-4 flex flex-col gap-3 border-t border-slate-200 pt-4 dark:border-slate-700"
              aria-label={p.state.creating() ? "Neuen Dienst hinzufügen" : `Dienst ${draft().id} bearbeiten`}
              onSubmit={(event) => {
                event.preventDefault()
                p.state.save()
              }}
            >
              <h3 class="text-lg font-semibold">{p.state.creating() ? "Neuer Dienst" : `Dienst ${draft().id}`}</h3>
              <div class="grid gap-3 sm:grid-cols-2">
                <Show when={p.state.creating()}>
                  <div class="flex flex-col gap-1">
                    <Label for="project-service-id">Dienst-ID</Label>
                    <Input
                      id="project-service-id"
                      value={draft().id}
                      required
                      pattern="[a-z0-9][a-z0-9-]*"
                      onInput={(event) => p.state.draftFieldSet("id", event.currentTarget.value)}
                    />
                  </div>
                </Show>
                <div class="flex flex-col gap-1">
                  <Label for="project-service-port">
                    Port {p.state.creating() ? "(optional, leer = automatisch)" : ""}
                  </Label>
                  <Input
                    id="project-service-port"
                    value={draft().port}
                    inputMode="numeric"
                    onInput={(event) => p.state.draftFieldSet("port", event.currentTarget.value)}
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <Label for="project-service-domains">Domains (kommagetrennt)</Label>
                  <Input
                    id="project-service-domains"
                    value={draft().domains}
                    required
                    onInput={(event) => p.state.draftFieldSet("domains", event.currentTarget.value)}
                  />
                </div>
                <div class="flex flex-col gap-1">
                  <Label for="project-service-kind">Art</Label>
                  <select
                    class={classesInput}
                    id="project-service-kind"
                    value={draft().kind}
                    onChange={(event) => p.state.draftFieldSet("kind", event.currentTarget.value)}
                  >
                    <option value="proxy">Proxy</option>
                    <option value="static">Statisch</option>
                  </select>
                </div>
                <div class="flex flex-col gap-1">
                  <Label for="project-service-access">Zugriff</Label>
                  <select
                    class={classesInput}
                    id="project-service-access"
                    value={draft().access}
                    onChange={(event) => p.state.draftFieldSet("access", event.currentTarget.value)}
                  >
                    <option value="external">Extern</option>
                    <option value="internal">Intern</option>
                  </select>
                </div>
                <div class="flex flex-col gap-1">
                  <Label for="project-service-path">Pfad</Label>
                  <Input
                    id="project-service-path"
                    value={draft().path}
                    onInput={(event) => p.state.draftFieldSet("path", event.currentTarget.value)}
                  />
                </div>
              </div>
              <div class="flex flex-wrap gap-4">
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft().disabled}
                    onChange={(event) => p.state.draftFieldSet("disabled", event.currentTarget.checked)}
                  />
                  Deaktiviert
                </label>
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft().docs}
                    onChange={(event) => p.state.draftFieldSet("docs", event.currentTarget.checked)}
                  />
                  Dokumentation
                </label>
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft().spa}
                    onChange={(event) => p.state.draftFieldSet("spa", event.currentTarget.checked)}
                  />
                  SPA
                </label>
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={draft().browse}
                    onChange={(event) => p.state.draftFieldSet("browse", event.currentTarget.checked)}
                  />
                  Verzeichnis anzeigen
                </label>
              </div>
              <div class="flex gap-2">
                <Button type="submit" disabled={p.state.saving()}>
                  {p.state.saving() ? "Wird gespeichert …" : "Speichern"}
                </Button>
                <Button type="button" variant="outline" onClick={p.state.editorClose} disabled={p.state.saving()}>
                  Abbrechen
                </Button>
              </div>
            </form>
          )}
        </Show>
      </div>
    </CardWrapper>
  )
}
