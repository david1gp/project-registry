import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import { type BadgeVariant, badgeCva1 } from "#ui/static/badge/badgeCva.jsx"

export interface BadgeProps extends ComponentProps<"div"> {
  variant?: BadgeVariant
}

/** Small styled badge label with variant. */
export const Badge: Component<BadgeProps> = (p) => {
  const [s, rest] = splitProps(p, ["variant", "class"])
  return <div class={badgeCva1(s.variant, s.class)} {...rest} />
}
