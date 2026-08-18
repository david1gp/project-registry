import type { PromiseResult } from "#result"

export interface PosixUserDirectory {
  usernameExists(username: string): PromiseResult<boolean>
}
