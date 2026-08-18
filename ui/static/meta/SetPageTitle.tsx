import { createEffect } from "solid-js"

export type SetPageTitleProps = {
  title: string
}

/** Sets the document title; renders nothing. */
export function SetPageTitle(p: SetPageTitleProps) {
  createEffect(() => {
    if (!p.title) return
    document.title = p.title
  })
  return null
}
