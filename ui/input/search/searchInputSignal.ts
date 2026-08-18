import { scheduleIdle } from "@solid-primitives/scheduled"
import { createSignalObject } from "#ui/utils/createSignalObject.js"

export const searchInputSignal = createSignalObject("")

export const searchInputDebouncedSignal = scheduleIdle(searchInputSignal.get)
// export const searchInputDebouncedSignal = createMemo(() => {
//   return scheduleIdle(searchInputSignal.get)
// })
