import type { PromiseResult } from "#result"

/** Alias only credential lookup, never the project or tracking owner. */
export function projectRegistryCredentialOwnerAliasWrap<T>(
  resolve: (owner: string) => PromiseResult<T>,
  aliases: Readonly<Record<string, string>>,
): (owner: string) => PromiseResult<T> {
  return (owner) => resolve(Object.hasOwn(aliases, owner) ? aliases[owner]! : owner)
}
