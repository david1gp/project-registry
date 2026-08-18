import type { Accessor } from "solid-js"

export type ValueOrAccessor<T> = T | Accessor<T>
