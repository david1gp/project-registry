import { mdiAlertCircle, mdiAlertOctagram, mdiCheckCircle, mdiInformationOutline } from "@mdi/js"

export type ToastVariant = keyof typeof toastVariant

export const toastVariant = {
  // filled grayscale
  filled: "filled",
  subtle: "subtle",
  default: "default",
  // filled colors
  primary: "primary",
  // filled colors status
  success: "success",
  info: "info",
  warning: "warning",
  error: "error",
} as const

export const toastVariantIcon = {
  // filled grayscale
  filled: "",
  subtle: "",
  default: "",
  // filled colors
  primary: "",
  // filled colors status
  success: mdiCheckCircle,
  info: mdiInformationOutline,
  warning: mdiAlertCircle,
  error: mdiAlertOctagram,
} as const satisfies Record<ToastVariant, string>
