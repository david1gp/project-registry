import Popover from "@corvu/popover"
import type { JSX } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import type { ButtonIcon1Props } from "#ui/interactive/button/ButtonIcon1.jsx"
import { buttonCva2 } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import { classesPopoverContentMerge } from "#ui/interactive/popover/classesPopoverContent.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

export interface CorvuPopoverProps extends MayHaveClass, MayHaveInnerClass, MayHaveChildren, ButtonIcon1Props {
  // buttonProps: ButtonIcon1Props
  buttonChildren?: JSX.Element

  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** Popover anchored to a labeled trigger button. */
export function CorvuPopover(p: CorvuPopoverProps) {
  // const [a, buttonProps] = splitProps(p.buttonProps, ["onClick"])
  return (
    <Popover
      floatingOptions={{
        offset: 8,
        flip: true,
        shift: true,
      }}
      open={p.open}
      onOpenChange={p.onOpenChange}
    >
      <Popover.Trigger
        class={buttonCva2(
          p.variant,
          p.size,
          classesButtonClickAnimation,
          (p.disabled || p.isDisabled?.()) && classesDisabledDirectly,
          p.class,
        )}
      >
        {p.icon && <Icon path={p.icon} class={buttonIconCva(p.variant, p.buttonChildren && "mr-2", p.iconClass)} />}
        {p.buttonChildren}
        {p.iconRight && (
          <Icon path={p.iconRight} class={buttonIconCva(p.variant, p.buttonChildren && "ml-2", p.iconClass)} />
        )}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content class={classesPopoverContentMerge(p.innerClass)}>{p.children}</Popover.Content>
      </Popover.Portal>
    </Popover>
  )
}
