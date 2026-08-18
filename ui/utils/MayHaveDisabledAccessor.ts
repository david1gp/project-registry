import type { ValueOrAccessor } from "#ui/utils/ValueOrAccessor.js"

export interface MayHaveDisabledAccessor {
  disabled?: ValueOrAccessor<boolean>
}

export function isDisabled(p: MayHaveDisabledAccessor): boolean | undefined {
  if (p.disabled === undefined) return undefined
  if (typeof p.disabled === "boolean") return p.disabled
  if (typeof p.disabled === "function") return p.disabled()
  return undefined
}
