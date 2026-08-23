import { mdiCardTextOutline } from "@adaptive-ds/mdi/mdiCardTextOutline.js"
import { mdiPlus } from "@adaptive-ds/mdi/mdiPlus.js"
import { mdiSquareEditOutline } from "@adaptive-ds/mdi/mdiSquareEditOutline.js"
import { mdiTrashCan } from "@adaptive-ds/mdi/mdiTrashCan.js"
import { type FormMode, formMode } from "#ui/input/form/formMode.js"

export const formModeIcon = {
  [formMode.view]: mdiCardTextOutline,
  [formMode.add]: mdiPlus,
  [formMode.edit]: mdiSquareEditOutline,
  [formMode.remove]: mdiTrashCan,
} as const satisfies Record<FormMode, string>
