import { createLink } from "@tanstack/solid-router"
import { splitProps } from "solid-js"
import { buttonCva2 } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import type { ButtonAnchorProps } from "#ui/interactive/link/LinkButtonProps.jsx"
import { Icon } from "#ui/static/icon/Icon.jsx"

/** Shared styled button-anchor; base for both link variants. */
function ButtonAnchor(p: ButtonAnchorProps) {
  const [s, rest] = splitProps(p, [
    "class",
    "variant",
    "size",
    "newTab",
    "isLoading",
    "icon",
    "iconRight",
    "iconClass",
    "children",
    "target",
    "rel",
  ])
  return (
    <a
      class={buttonCva2(
        s.variant,
        s.size,
        "break-all", // line breaks for long links
        s.class,
      )}
      target={s.newTab ? "_blank" : s.target}
      rel={s.newTab ? "noopener noreferrer" : s.rel}
      {...rest}
    >
      {s.icon && <Icon path={s.icon} class={buttonIconCva(s.variant, s.children && "mr-2", s.iconClass)} />}
      {s.children}
      {s.iconRight && <Icon path={s.iconRight} class={buttonIconCva(s.variant, s.children && "ml-2", s.iconClass)} />}
    </a>
  )
}

/** Internal button link — typed `to`, client-side nav + preload. Needs a RouterProvider. */
export const LinkButtonInternal = createLink(ButtonAnchor)

/** External button link — plain `<a>` for external/runtime URLs. */
export function LinkButtonExternal(p: ButtonAnchorProps & { href: string }) {
  return <ButtonAnchor {...p} />
}
