import type { PromiseResult } from "#result"
import type { IdentityDirectoryUser } from "./IdentityDirectoryUser.js"

export interface IdentityDirectory {
  usersList(accessToken: string): PromiseResult<readonly IdentityDirectoryUser[]>
  userRolesList(subject: string, accessToken: string): PromiseResult<readonly unknown[]>
  userPreferredUsernameResolve(subject: string, accessToken: string): PromiseResult<string>
}
