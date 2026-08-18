import { createLink } from "@tanstack/solid-router"
import { splitProps } from "solid-js"
import { buttonCvaIconOnly } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import type { ButtonAnchorProps } from "#ui/interactive/link/LinkButtonProps.jsx"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { isLoading } from "#ui/utils/MayHaveIsLoading.js"

/** Shared styled icon-only button-anchor; base for both link variants. */
function ButtonIconOnlyAnchor(p: ButtonAnchorProps) {
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
      class={buttonCvaIconOnly(
        s.variant,
        isLoading({ isLoading: s.isLoading }),
        false,
        classesButtonClickAnimation,
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

/** Internal icon-only button link — typed `to`, client-side nav + preload. Needs a RouterProvider. */
export const LinkButtonIconOnlyInternal = createLink(ButtonIconOnlyAnchor)

/** External icon-only button link — plain `<a>` for external/runtime URLs. */
export function LinkButtonIconOnlyExternal(p: ButtonAnchorProps & { href: string }) {
  return <ButtonIconOnlyAnchor {...p} />
}
