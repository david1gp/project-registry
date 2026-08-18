import { createLink } from "@tanstack/solid-router"
import { splitProps } from "solid-js"
import { classesTextLink } from "#ui/classes/classesTextLink.js"
import type { LinkTextProps } from "#ui/interactive/link/LinkTextProps.jsx"
import { classMerge } from "#ui/utils/classMerge.js"

/** Shared styled inline text-link anchor. */
function TextAnchor(p: LinkTextProps) {
  const [s, rest] = splitProps(p, ["class"])
  return (
    <a
      class={classMerge(
        classesTextLink,
        "no-underline hover:underline", // underline
        "break-all", // line breaks
        s.class,
      )}
      {...rest}
    />
  )
}

/** Internal text link — typed `to`, client-side nav + preload. Needs a RouterProvider. */
export const LinkTextInternal = createLink(TextAnchor)

/** External text link — plain `<a>` for external/runtime/`mailto:`/`#hash` URLs. */
export function LinkTextExternal(p: LinkTextProps & { href: string }) {
  return <TextAnchor {...p} />
}
