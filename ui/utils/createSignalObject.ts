import { type Accessor, createSignal } from "solid-js"

//
// https://www.reddit.com/r/solidjs/comments/17r9dgm/signal_gettersetter_naming_convention/
//

export type SetterSimplified<T> = (t: T) => void

export type SignalObject<T> = { get: Accessor<T>; set: SetterSimplified<T> }

export function createSignalObject<T>(v: T): SignalObject<T> {
  const [get, set] = createSignal(v)
  return { get, set }
}
