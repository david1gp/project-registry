import { expect, test } from "bun:test"
import { type SharedRootsPolicyEntry, sharedRootsPolicy } from "./sharedRootsPolicy.js"

test("shared roots policy closes /servers to non-members via stripOther", () => {
  expect([...sharedRootsPolicy]).toEqual([
    { root: "/projects", group: "projects" },
    { root: "/servers", group: "servers", stripOther: true },
    { root: "/opensource", group: "projects" },
    { root: "/adaptive", group: "projects" },
  ])
  const entries: readonly SharedRootsPolicyEntry[] = sharedRootsPolicy
  for (const entry of entries) {
    if (entry.root === "/servers") expect(entry.stripOther).toBe(true)
    else expect(entry.stripOther ?? false).toBe(false)
  }
})
