import type { JSX } from "solid-js"
import { createUniqueId } from "solid-js"
import { projectServicesPanelStateCreate } from "./ProjectServicesPanelStateCreate.js"
import { ProjectServicesPanelView } from "./ProjectServicesPanelView.jsx"
import { projectServicesSearchParamsCreate } from "./projectServicesSearchParamsCreate.js"

export function ProjectServicesPanel(p: { owner: string; name: string }): JSX.Element {
  const state = projectServicesPanelStateCreate(
    () => p.owner,
    () => p.name,
    { searchParams: projectServicesSearchParamsCreate() },
  )
  return <ProjectServicesPanelView state={state} titleId={`${createUniqueId()}-services-title`} />
}
