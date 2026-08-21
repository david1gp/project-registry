import type { JSX } from "solid-js"
import { PageWrapper } from "#ui/static/page/PageWrapper.jsx"
import { ProjectAccessLogPanel } from "./ProjectAccessLogPanel.js"
import { projectDetailPageStateCreate } from "./ProjectDetailPageStateCreate.js"

export function ProjectDetailPage(): JSX.Element {
  const state = projectDetailPageStateCreate()
  return (
    <PageWrapper>
      <main class="flex min-h-screen w-full flex-col gap-6 px-4 py-8 text-slate-900 dark:text-slate-100 sm:px-6">
        <header>
          <p class="text-sm text-slate-600 dark:text-slate-300">Projekt von {state.owner()}</p>
          <h1 class="text-3xl font-semibold">{state.name()}</h1>
        </header>
        <ProjectAccessLogPanel owner={state.owner()} name={state.name()} />
      </main>
    </PageWrapper>
  )
}
