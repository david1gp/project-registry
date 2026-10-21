const privateDefaultOwners = new Set(["leo", "david"])

/**
 * Creation default for route network visibility by project owner.
 * New leo/david routes default to private Tailscale serving;
 * all other owners (including fabian/musa) default to public.
 */
export function projectNetworkVisibilityDefault(owner: string): "public" | "private" {
  return privateDefaultOwners.has(owner.trim()) ? "private" : "public"
}
