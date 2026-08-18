import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import { type ButtonCvaProps, buttonCva2 } from "#ui/interactive/button/buttonCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"

export interface ButtonProps extends ComponentProps<"button">, ButtonCvaProps {}

/** Primary clickable button with variant and size styling and a click animation. */
export const Button: Component<ButtonProps> = (p) => {
  const [s, rest] = splitProps(p, ["variant", "size", "class", "type"])
  return (
    <button
      class={buttonCva2(s.variant, s.size, classesButtonClickAnimation, p.disabled && classesDisabledDirectly, s.class)}
      type={s.type ?? "button"}
      {...rest}
    />
  )
}
