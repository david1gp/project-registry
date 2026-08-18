import type { JSX } from "solid-js"
import { PageWrapper } from "#ui/static/page/PageWrapper.jsx"

export function HelloWorldPage(): JSX.Element {
  return (
    <PageWrapper>
      <main class="flex min-h-screen items-center justify-center px-6 text-slate-900 dark:text-slate-100">
        <h1 class="text-4xl font-semibold">Hello, Project Registry</h1>
      </main>
    </PageWrapper>
  )
}
