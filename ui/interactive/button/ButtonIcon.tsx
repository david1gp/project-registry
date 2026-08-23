import { mdiLoading } from "@adaptive-ds/mdi/mdiLoading.js"
import { type Component, type ComponentProps, splitProps } from "solid-js"
import { Button } from "#ui/interactive/button/Button.jsx"
import type { ButtonCvaProps, ButtonVariant } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"

export interface ButtonIconProps extends ComponentProps<"button">, ButtonCvaProps {
  // icon
  icon?: string
  iconRight?: string
  iconClass?: string
  // loading
  isLoading?: boolean
  // validating
  validationMessage?: string
  validationVariant?: ButtonVariant
  validationIcon?: string
}

/** Button with icon, loading, and validation states. */
export const ButtonIcon: Component<ButtonIconProps> = (p) => {
  const [s, rest] = splitProps(p, [
    // icon
    "icon",
    "iconRight",
    "iconClass",
    // loading
    "isLoading",
    // validating
    "validationMessage",
    "validationVariant",
    "validationIcon",
    // button
    "variant",
    "size",
    "class",
    "disabled",
    "onClick",
    "children",
  ])
  const onClick2 = (e: any) => {
    if (s.disabled) return
    if (s.isLoading) return
    if (s.validationMessage) return
    if (s.onClick && typeof s.onClick === "function") {
      s.onClick(e)
    }
  }
  return (
    <Button
      class={classMerge(
        classesButtonClickAnimation,
        (s.isLoading || !!s.validationMessage) && "cursor-not-allowed",
        s.class,
      )}
      variant={s.validationMessage ? s.validationVariant : s.variant}
      size={s.size}
      onClick={onClick2}
      disabled={s.disabled}
      aria-disabled={s.isLoading || !!s.validationMessage}
      {...rest}
    >
      {(s.isLoading || s.validationMessage || s.icon) && (
        <Icon
          path={(s.isLoading ? mdiLoading : s.validationMessage ? s.validationIcon : (s.icon ?? mdiLoading))!}
          class={buttonIconCva(
            s.validationMessage ? s.validationVariant : s.variant,
            s.children && "mr-2",
            s.isLoading && "animate-spin",
            s.iconClass,
          )}
        />
      )}
      {s.validationMessage ? s.validationMessage : s.children}
      {!s.isLoading && !s.validationMessage && s.iconRight && (
        <Icon
          path={s.iconRight}
          class={buttonIconCva(
            s.validationMessage ? s.validationVariant : s.variant,
            s.children && "ml-2",
            s.isLoading && "animate-spin",
            s.iconClass,
          )}
        />
      )}
    </Button>
  )
}
