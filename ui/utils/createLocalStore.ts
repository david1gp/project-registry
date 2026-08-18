import { createEffect } from "solid-js"
import { createStore, type SetStoreFunction, type Store } from "solid-js/store"

export function createLocalStore<T extends object>(initState: T, storageKey: string): [Store<T>, SetStoreFunction<T>] {
  const [state, setState] = createStore(initState)
  if (localStorage[storageKey]) setState(JSON.parse(localStorage[storageKey]))
  createEffect(() => (localStorage[storageKey] = JSON.stringify(state)))
  return [state, setState]
}
