import type { ProjectKey } from "../project/projectKey.js"

export type ProjectRepositoryTransaction = {
  action: "transaction"
  changed: boolean
  revision: string
  localCommit: { status: "committed" | "unchanged"; revision: string }
  push: { requested: boolean; status: "not-requested" | "pushed" | "failed"; errorMessage?: string }
  written: ProjectKey[]
  removed: ProjectKey[]
}
