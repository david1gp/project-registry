import { expect, test } from "bun:test"
import { createResult } from "#result"
import { projectRegistryCredentialOwnerAliasWrap } from "./projectRegistryCredentialOwnerAliasWrap.js"

test("credential aliases affect lookup only, preserving direct owner lookups", async () => {
  const owners: string[] = []
  const resolve = projectRegistryCredentialOwnerAliasWrap(
    async (owner) => {
      owners.push(owner)
      return createResult(`token-${owner}`)
    },
    { shared: "leo" },
  )
  expect(await resolve("shared")).toEqual(createResult("token-leo"))
  expect(await resolve("leo")).toEqual(createResult("token-leo"))
  expect(await resolve("david")).toEqual(createResult("token-david"))
  expect(owners).toEqual(["leo", "leo", "david"])
})
