import type { JSXElement } from "solid-js"
import type { ToastVariant } from "#ui/interactive/toast/toastVariant.js"
import type { HasTitle } from "#ui/utils/HasTitle.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveIcon } from "#ui/utils/MayHaveIcon.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"

export interface AddToastProps extends MayHaveId, MayHaveIcon, HasTitle, MayHaveClass, MayHaveChildren {
  variant?: ToastVariant
  duration?: number

  description?: string
  descriptionClass?: string

  texts?: ToastTexts
}

export type ToastTexts = {
  close: string
}

export interface ToastPropsInternal extends AddToastProps {
  id: string
  // variant: ToastVariant
}

export type ToastProps = {
  id: string
  variant?: ToastVariant
  duration?: number
  icon?: string
  iconCn?: string
  title?: JSXElement
  description?: JSXElement
}
