import type { ProjectCanonical } from "../project/projectCanonicalSchema.js"
import { wikiProjectNameNormalize } from "./wikiProjectNameNormalize.js"

export type WikiProjectEntry = {
  parent: "Externe" | "Interne"
  folder: string
  folderPath: string
  notePath: string
  noteName: string
  frontmatter: Record<string, unknown>
  hasPrimary: boolean
  ancillaries: { noteName: string; notePath: string; frontmatter: Record<string, unknown> }[]
}

export type WikiProjectResolution =
  | { kind: "identity" | "name"; entry: WikiProjectEntry }
  | { kind: "none" }
  | { kind: "ambiguous"; entries: WikiProjectEntry[] }

function wikiProjectResolveIdentityMatch(project: ProjectCanonical, frontmatter: Record<string, unknown>): boolean {
  const registry = frontmatter.projectRegistry
  if (!registry || typeof registry !== "object" || Array.isArray(registry)) return false
  const record = registry as Record<string, unknown>
  return record.owner === project.owner && record.name === project.name
}

function wikiProjectResolveIdentity(
  project: ProjectCanonical,
  entries: readonly WikiProjectEntry[],
): WikiProjectEntry[] {
  return entries.filter(
    (entry) =>
      wikiProjectResolveIdentityMatch(project, entry.frontmatter) ||
      entry.ancillaries.some((ancillary) => wikiProjectResolveIdentityMatch(project, ancillary.frontmatter)),
  )
}

function wikiProjectResolveCandidates(project: ProjectCanonical): Set<string> {
  const candidates = new Set([wikiProjectNameNormalize(project.name)])
  const alternativeName = project.labels.alternativeName?.trim()
  if (alternativeName) candidates.add(wikiProjectNameNormalize(alternativeName))
  candidates.delete("")
  return candidates
}

export function wikiProjectResolve(
  project: ProjectCanonical,
  entries: readonly WikiProjectEntry[],
): WikiProjectResolution {
  const identity = wikiProjectResolveIdentity(project, entries)

  const candidates = wikiProjectResolveCandidates(project)
  const named = entries.filter((entry) => {
    const folder = wikiProjectNameNormalize(entry.folder)
    if (candidates.has(folder)) return true
    // Only a case-insensitive exact primary note stem counts. Ancillary
    // stems (Emails, Links, ...) must never claim a folder.
    if (!entry.hasPrimary) return false
    const stem = wikiProjectNameNormalize(entry.noteName.replace(/\.md$/i, ""))
    return candidates.has(stem)
  })
  // Union identity and name matches: an identity hit plus a distinct name hit
  // means two folders claim one registry project, so skip instead of guessing.
  const distinct = [...new Map([...identity, ...named].map((entry) => [entry.notePath, entry])).values()]
  if (distinct.length === 0) return { kind: "none" }
  if (distinct.length > 1) return { kind: "ambiguous", entries: distinct }
  const single = distinct[0]!
  return identity.includes(single) ? { kind: "identity", entry: single } : { kind: "name", entry: single }
}
