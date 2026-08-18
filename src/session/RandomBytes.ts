import type { Result } from "#result"

export type RandomBytes = (length: number) => Result<Uint8Array>
