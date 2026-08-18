import { Show } from "solid-js"
import { LinkTextExternal } from "#ui/interactive/link/LinkText.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface TextOrLinkProps extends MayHaveClass {
  text: string
}

/** Renders text as a link when it starts with http. */
export function TextOrLink(p: TextOrLinkProps) {
  const isLink = () => p.text.startsWith("http")

  return (
    <Show when={isLink()} fallback={<p class={classMerge(p.class)}>{p.text}</p>}>
      <LinkTextExternal href={p.text}>{p.text}</LinkTextExternal>
    </Show>
  )
}
