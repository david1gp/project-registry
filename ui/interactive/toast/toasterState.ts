import { createToasterState } from "#ui/interactive/toast/GlobalToasterState.js"
import { createSignalObject } from "#ui/utils/createSignalObject.js"

export const toasterState = createSignalObject(createToasterState())
