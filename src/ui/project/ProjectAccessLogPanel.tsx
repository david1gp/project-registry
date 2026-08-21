import type { JSX } from "solid-js"
import { createUniqueId } from "solid-js"
import { projectAccessLogPanelStateCreate } from "./ProjectAccessLogPanelStateCreate.js"
import { ProjectAccessLogPanelView } from "./ProjectAccessLogPanelView.jsx"

export function ProjectAccessLogPanel(p: { owner: string; name: string }): JSX.Element {
  const state = projectAccessLogPanelStateCreate(
    () => p.owner,
    () => p.name,
  )
  return <ProjectAccessLogPanelView state={state} titleId={`${createUniqueId()}-access-log-title`} />
}
