import { mdiCardTextOutline, mdiPlus, mdiSquareEditOutline, mdiTrashCan } from "@mdi/js"
import { type FormMode, formMode } from "#ui/input/form/formMode.js"

export const formModeIcon = {
  [formMode.view]: mdiCardTextOutline,
  [formMode.add]: mdiPlus,
  [formMode.edit]: mdiSquareEditOutline,
  [formMode.remove]: mdiTrashCan,
} as const satisfies Record<FormMode, string>
