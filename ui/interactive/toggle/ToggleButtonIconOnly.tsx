import { type Component, type ComponentProps, splitProps } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import { type ButtonCvaProps, buttonCvaIconOnly } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import type { SignalObject } from "#ui/utils/createSignalObject.js"
import type { HasIcon } from "#ui/utils/HasIcon.js"
import type { HasTitle } from "#ui/utils/HasTitle.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import { isDisabled } from "#ui/utils/MayHaveDisabledAccessor.js"
import { isLoading, type MayHaveIsLoading } from "#ui/utils/MayHaveIsLoading.js"

export interface ToggleButtonIconOnlyProps
  extends Omit<ComponentProps<"button">, "title" | "onClick">,
    ButtonCvaProps,
    HasTitle,
    HasIcon,
    MayHaveIsLoading,
    MayHaveChildren {
  pressedSignal: SignalObject<boolean>
  onPressedChange?: (pressed: boolean) => void
  onClick?: (e: MouseEvent & { currentTarget: HTMLButtonElement; target: Element }) => void
}

/** Icon-only button toggling a pressed signal. */
export const ToggleButtonIconOnly: Component<ToggleButtonIconOnlyProps> = (p) => {
  const [s, rest] = splitProps(p, [
    "variant",
    "size",
    "class",
    "isLoading",
    "title",
    "icon",
    "iconClass",
    "type",
    "disabled",
    "pressedSignal",
    "onPressedChange",
    "onClick",
    "children",
  ])
  return (
    <button
      class={buttonCvaIconOnly(s.variant, isLoading(p), isDisabled(p), classesButtonClickAnimation, s.class)}
      title={s.title}
      type={s.type ?? "button"}
      aria-pressed={s.pressedSignal.get()}
      data-state={s.pressedSignal.get() ? "on" : "off"}
      data-disabled={isDisabled(p)}
      onClick={(e) => {
        const next = togglePressed(p)
        if (s.onPressedChange) {
          s.onPressedChange(next)
        }
        if (s.onClick) s.onClick(e)
      }}
      {...rest}
    >
      <Icon
        path={s.icon}
        class={buttonIconCva(
          s.variant,
          s.isLoading && "animate-spin-faster",
          s.disabled && classesDisabledDirectly,
          s.iconClass,
        )}
      />
      {s.children}
    </button>
  )
}

function togglePressed(
  s: Pick<ToggleButtonIconOnlyProps, "disabled" | "title" | "pressedSignal" | "onPressedChange" | "onClick">,
): boolean {
  const next = !s.pressedSignal.get()
  s.pressedSignal.set(next)
  return next
}
