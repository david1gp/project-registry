export type SharedRootsPolicyEntry = {
  root: string
  group: string
  /**
   * Private roots grant nothing to other users: the hourly root reconciler
   * strips mode other-bits and forces other::--- default ACLs throughout
   * this root only. Group sharing is unchanged.
   */
  stripOther?: boolean
}

export const sharedRootsPolicy = [
  { root: "/projects", group: "projects" },
  // /servers is closed to non-members; see stripOther above.
  { root: "/servers", group: "servers", stripOther: true },
  { root: "/opensource", group: "projects" },
  { root: "/adaptive", group: "projects" },
] as const satisfies readonly SharedRootsPolicyEntry[]
