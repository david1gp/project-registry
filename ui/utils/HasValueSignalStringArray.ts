import type { SignalObject } from "#ui/utils/createSignalObject.js"

export interface HasValueSignalStringArray {
  valueSignal: SignalObject<string[]>
}
