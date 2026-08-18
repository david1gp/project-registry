import Dialog from "@corvu/dialog"
import { mdiClose } from "@mdi/js"
import { type Component, type ComponentProps, splitProps } from "solid-js"
import { classesDisabledDirectly } from "#ui/classes/classesDisabledDirectly.js"
import { type ButtonCvaProps, buttonCvaIconOnly, buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { buttonIconCva } from "#ui/interactive/button/buttonIconCva.js"
import { classesButtonClickAnimation } from "#ui/interactive/button/classesButtonClickAnimation.js"
import type { CorcuDialogTexts } from "#ui/interactive/dialog/CorcuDialogTexts.js"
import { corvuDialogTextDefault } from "#ui/interactive/dialog/CorcuDialogTexts.js"
import { classesDialogContentMerge, classesDialogOverlayMerge } from "#ui/interactive/dialog/classesDialogContent.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classMerge } from "#ui/utils/classMerge.js"
import type { HasIcon } from "#ui/utils/HasIcon.js"
import type { HasTitle } from "#ui/utils/HasTitle.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"
import { isLoading, type MayHaveIsLoading } from "#ui/utils/MayHaveIsLoading.js"

export interface CorvuDialogIconProps
  extends Omit<ComponentProps<"button">, "title">,
    ButtonCvaProps,
    HasIcon,
    HasTitle,
    MayHaveClass,
    MayHaveInnerClass,
    MayHaveChildren,
    MayHaveIsLoading {
  dialogTitle: string
  description?: string
  titleClass?: string
  descriptionClass?: string
  texts?: CorcuDialogTexts
}

/** Modal dialog opened by an icon-only trigger. */
export const CorvuDialogIcon: Component<CorvuDialogIconProps> = (p) => {
  const [s, rest] = splitProps(p, [
    // button
    "variant",
    "size",
    "class",
    // state
    "isLoading",
    "disabled",
    // icons
    "title",
    "icon",
    "iconClass",
    // dialog
    "innerClass",
    "children",
    "dialogTitle",
    "description",
    "titleClass",
    "descriptionClass",
    "texts",
  ])

  const texts = s.texts ?? corvuDialogTextDefault

  return (
    <Dialog>
      <Dialog.Trigger
        class={buttonCvaIconOnly(s.variant, isLoading(p), s.disabled, classesButtonClickAnimation, s.class)}
        title={s.title}
        {...rest}
      >
        <Icon
          path={s.icon}
          class={buttonIconCva(
            s.variant,
            isLoading(p) && "animate-spin-faster",
            s.disabled && classesDisabledDirectly,
            s.iconClass,
          )}
        />
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay class={classesDialogOverlayMerge()} />
        <Dialog.Content class={classesDialogContentMerge(s.innerClass)}>
          <header class="flex items-start justify-between mb-4">
            <div>
              <Dialog.Label class={classMerge("text-lg font-semibold", s.titleClass)}>{s.dialogTitle}</Dialog.Label>
              {s.description && (
                <Dialog.Description class={classMerge("text-muted-foreground", s.descriptionClass)}>
                  {s.description}
                </Dialog.Description>
              )}
            </div>
            <Dialog.Close class={buttonCvaIconOnly(buttonVariant.outline, false, false)} title={texts.closeDialog}>
              <Icon path={mdiClose} class={buttonIconCva(buttonVariant.outline, "")} />
            </Dialog.Close>
          </header>
          {s.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
