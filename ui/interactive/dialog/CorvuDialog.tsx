import Dialog from "@corvu/dialog"
import { mdiClose } from "@adaptive-ds/mdi/mdiClose.js"
import type { JSX } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import type { ButtonIcon1Props } from "#ui/interactive/button/ButtonIcon1.jsx"
import { buttonCva2, buttonCvaIconOnly, buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import type { CorcuDialogTexts } from "#ui/interactive/dialog/CorcuDialogTexts.js"
import { corvuDialogTextDefault } from "#ui/interactive/dialog/CorcuDialogTexts.js"
import { classesDialogContentMerge, classesDialogOverlayMerge } from "#ui/interactive/dialog/classesDialogContent.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

export interface CorvuDialogProps extends MayHaveClass, MayHaveInnerClass, MayHaveChildren, ButtonIcon1Props {
  buttonChildren?: JSX.Element
  title: string
  description?: string
  titleClass?: string
  descriptionClass?: string
  texts?: CorcuDialogTexts

  open?: boolean
  onOpenChange?: (open: boolean) => void
}

/** Modal dialog with titled header and trigger button. */
export function CorvuDialog(p: CorvuDialogProps) {
  const texts = p.texts ?? corvuDialogTextDefault

  return (
    <Dialog open={p.open} onOpenChange={p.onOpenChange}>
      <Dialog.Trigger
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
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay class={classesDialogOverlayMerge()} />
        <Dialog.Content class={classesDialogContentMerge(p.innerClass)}>
          <header class="flex items-center justify-between gap-2 mb-4">
            <div>
              <Dialog.Label class={classMerge("text-lg font-semibold", p.titleClass)}>{p.title}</Dialog.Label>
              {p.description && (
                <Dialog.Description class={classMerge("text-muted-foreground", p.descriptionClass)}>
                  {p.description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close class={buttonCvaIconOnly(buttonVariant.outline, false, false)} title={texts.closeDialog}>
              <Icon path={mdiClose} class={buttonIconCva(buttonVariant.outline, "")} />
            </Dialog.Close>
          </header>
          {p.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
