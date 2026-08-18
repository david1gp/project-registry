import type { CsrfTokenStore } from "../session/CsrfTokenStore.js"

export type MutationSecurityOptions = {
  origin: string | null | undefined
  expectedOrigin: string
  sessionId: string
  csrfToken: string
  csrf: CsrfTokenStore
  timeoutMs?: number
  signal?: AbortSignal
}
