import { type Component, type ComponentProps, splitProps } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import { type ButtonCvaProps, buttonCvaIconOnly } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import type { HasIcon } from "#ui/utils/HasIcon.js"
import type { HasTitle } from "#ui/utils/HasTitle.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import { isDisabled } from "#ui/utils/MayHaveDisabledAccessor.js"
import { isLoading, type MayHaveIsLoading } from "#ui/utils/MayHaveIsLoading.js"

export interface ButtonIconOnlyProps
  extends Omit<ComponentProps<"button">, "title">,
    ButtonCvaProps,
    HasTitle,
    HasIcon,
    MayHaveIsLoading,
    MayHaveChildren {
  iconRight?: boolean
}

/** Rounded icon-only button; pass a single icon and no children. */
export const ButtonIconOnly: Component<ButtonIconOnlyProps> = (p) => {
  const [s, rest] = splitProps(p, [
    // button
    "variant",
    "size",
    "class",
    // state
    "isLoading",
    // icons
    "title",
    "icon",
    "iconRight",
    "iconClass",
    // default
    "type",
    "disabled",
    "children",
  ])
  return (
    <button
      class={buttonCvaIconOnly(s.variant, isLoading(p), isDisabled(p), classesButtonClickAnimation, s.class)}
      title={s.title}
      type={s.type ?? "button"}
      {...rest}
    >
      {!s.iconRight && (
        <Icon
          path={s.icon}
          class={buttonIconCva(
            s.variant,
            s.children && "mr-2",
            s.isLoading && "animate-spin-faster",
            s.disabled && classesDisabledDirectly,
            s.iconClass,
          )}
        />
      )}
      {s.children}
      {s.iconRight && <Icon path={s.icon} class={buttonIconCva(s.variant, s.iconClass)} />}
    </button>
  )
}
