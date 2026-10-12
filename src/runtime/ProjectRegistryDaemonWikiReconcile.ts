import type { Result } from "#result"
import type { WikiReconcileInput, WikiReconcileSummary } from "../wiki/wikiReconcile.js"

export type ProjectRegistryDaemonWikiReconcile = (input: WikiReconcileInput) => Promise<Result<WikiReconcileSummary>>
