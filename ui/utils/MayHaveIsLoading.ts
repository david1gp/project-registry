import type { ValueOrAccessor } from "#ui/utils/ValueOrAccessor.js"

export type MayHaveIsLoading = {
  isLoading?: ValueOrAccessor<boolean>
}

export function isLoading(p: MayHaveIsLoading): boolean | undefined {
  if (p.isLoading === undefined) return undefined
  if (typeof p.isLoading === "boolean") return p.isLoading
  if (typeof p.isLoading === "function") return p.isLoading()
  return undefined
}
