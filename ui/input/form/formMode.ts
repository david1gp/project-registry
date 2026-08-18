import { ttt } from "#ui/i18n/ttt.js"

export type FormMode = keyof typeof formMode

export const formMode = {
  view: "view",
  add: "add",
  edit: "edit",
  remove: "remove",
} as const

export function getFormModeTitle(mode: FormMode, subject: string): string {
  switch (mode) {
    case formMode.view:
      return ttt("View") + " " + subject
    case formMode.add:
      return ttt("Add") + " " + subject
    case formMode.edit:
      return ttt("Edit") + " " + subject
    case formMode.remove:
      return ttt("Remove") + " " + subject
  }
}

export function getFormModeButtonTitle(mode: FormMode, subject: string): string {
  if (mode === formMode.edit) {
    return ttt("Save") + " " + subject
  }
  return getFormModeTitle(mode, subject)
}

export interface HasFormMode {
  mode: FormMode
}

export function formModeIsReadOnly(mode: FormMode): boolean {
  return mode === formMode.view || mode === formMode.remove
}
