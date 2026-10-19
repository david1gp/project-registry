import type { Result } from "#result"

export type CloudflareZarazRequest = (
  path: string,
  init: RequestInit,
) => Promise<Result<{ status: number; body: unknown }>>
