import type { PromiseResult } from "#result"

export type ProjectDocsPublicationStore = {
  directory(owner: string): string
  publish(owner: string, sourcePath: string, markdown: string): PromiseResult<{ file: string; index: string }>
}
