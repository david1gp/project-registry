import type { PromiseResult } from "#result"

export type ProjectRegistryDaemonCloudflareCredentials = {
  tokenResolve(owner: string): PromiseResult<string | undefined>
  /**
   * Update a root-managed owner credential file. This is a privileged filesystem operation; callers must
   * authenticate and authorize the owner before invoking it.
   */
  tokenSet(owner: string, token: string): PromiseResult<{ updated: true }>
}
