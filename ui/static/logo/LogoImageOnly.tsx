import type { ComponentProps } from "solid-js"
import { type ButtonVariant, buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { LinkButtonIconOnlyInternal } from "#ui/interactive/link/LinkButtonIconOnly.jsx"
import { Img } from "#ui/static/img/Img.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface LogoImageOnlyProps extends MayHaveClass {
  /** Typed internal route to navigate to; defaults to `"/"`. */
  to?: ComponentProps<typeof LinkButtonIconOnlyInternal>["to"]
  logoUrl?: string
  imageClass?: string
  variant?: ButtonVariant
}

/** Clickable logo image link without text. */
export function LogoImageOnly(p: LogoImageOnlyProps) {
  return (
    <LinkButtonIconOnlyInternal
      to={p.to ?? "/"}
      variant={p.variant ?? buttonVariant.ghost}
      class={classMerge("flex gap-1.5", p.class)}
    >
      <Img src={p.logoUrl ?? "/logo.svg"} alt={"Logo"} zoomIn={false} class={classMerge("size-7 mr-1", p.imageClass)} />
    </LinkButtonIconOnlyInternal>
  )
}
