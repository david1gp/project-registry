import { type Accessor, type Component, type ComponentProps, splitProps } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import { type ButtonCvaProps, buttonCva2 } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"

export interface ButtonIcon1Props extends ComponentProps<"button">, ButtonCvaProps, MayHaveClass, MayHaveChildren {
  // icon
  icon?: string
  iconRight?: string
  iconClass?: string
  // disabled
  isDisabled?: Accessor<boolean>
}

/** Button with optional left and right icons. */
export const ButtonIcon1: Component<ButtonIcon1Props> = (p) => {
  const [s, rest] = splitProps(p, [
    // generic
    "class",
    "children",
    // button
    "variant",
    "size",
    "class",
    // icon
    "icon",
    "iconRight",
    "iconClass",
    // disabled
    "disabled",
    "isDisabled",
    "type",
    "children",
    "onClick",
  ])
  const onClick2 = (e: any) => {
    if (s.isDisabled?.()) return
    if (s.disabled) return
    if (s.onClick) {
      // @ts-expect-error
      s.onClick(e)
    }
  }
  return (
    <button
      class={buttonCva2(
        s.variant,
        s.size,
        classesButtonClickAnimation,
        (s.disabled || s.isDisabled?.()) && classesDisabledDirectly,
        s.class,
      )}
      onClick={onClick2}
      aria-disabled={s.isDisabled?.()}
      type={s.type ?? "button"}
      {...rest}
    >
      {s.icon && <Icon path={s.icon} class={buttonIconCva(s.variant, s.children && "mr-2", s.iconClass)} />}
      {s.children}
      {s.iconRight && <Icon path={s.iconRight} class={buttonIconCva(s.variant, s.children && "ml-2", s.iconClass)} />}
    </button>
  )
}
