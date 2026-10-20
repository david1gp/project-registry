import type { CaddyInstanceConfig } from "./caddyInstanceConfigSchema.js"

export type CaddyInstanceTarget = {
  adminUrl: string
  httpsListeners: string[]
  baseConfigPath?: string
  caddyUser?: string
  caddyGroup?: string
  accessLogRoot?: string
}

export type CaddyInstanceTargets = {
  public: CaddyInstanceTarget
  private?: CaddyInstanceTarget
}

type CaddyInstanceTargetsResolveInput = {
  caddyAdminUrl: string
  httpsListener: string
  caddyBaseConfigPath?: string
  caddyUser?: string
  caddyGroup?: string
  caddyAccessLogRoot?: string
  caddyInstances?: CaddyInstanceConfig
}

// Pure inheritance merge with no validation. Flat daemon fields stay the
// default public behavior when the map is absent. Inside the map, public
// overrides fall back to flat fields per key, while the private target only
// takes admin/listeners/baseline from its required entry: its access-log
// root never inherits the flat root so both Caddy instances cannot write
// the same project log files concurrently. Service identity and shared OIDC
// inherit the flat values for both targets.
export function caddyInstanceTargetsResolve(input: CaddyInstanceTargetsResolveInput): CaddyInstanceTargets {
  const publicInstance = input.caddyInstances?.public
  const publicTarget: CaddyInstanceTarget = {
    adminUrl: publicInstance?.adminUrl ?? input.caddyAdminUrl,
    httpsListeners:
      publicInstance?.httpsListeners === undefined ? [input.httpsListener] : [...publicInstance.httpsListeners],
  }
  const publicBaseConfigPath = publicInstance?.baseConfigPath ?? input.caddyBaseConfigPath
  if (publicBaseConfigPath !== undefined) publicTarget.baseConfigPath = publicBaseConfigPath
  const publicUser = publicInstance?.caddyUser ?? input.caddyUser
  if (publicUser !== undefined) publicTarget.caddyUser = publicUser
  const publicGroup = publicInstance?.caddyGroup ?? input.caddyGroup
  if (publicGroup !== undefined) publicTarget.caddyGroup = publicGroup
  const publicAccessLogRoot = publicInstance?.accessLogRoot ?? input.caddyAccessLogRoot
  if (publicAccessLogRoot !== undefined) publicTarget.accessLogRoot = publicAccessLogRoot

  const privateInstance = input.caddyInstances?.private
  if (privateInstance === undefined) return { public: publicTarget }

  const privateTarget: CaddyInstanceTarget = {
    adminUrl: privateInstance.adminUrl,
    httpsListeners: [...privateInstance.httpsListeners],
    baseConfigPath: privateInstance.baseConfigPath,
  }
  const privateUser = privateInstance.caddyUser ?? input.caddyUser
  if (privateUser !== undefined) privateTarget.caddyUser = privateUser
  const privateGroup = privateInstance.caddyGroup ?? input.caddyGroup
  if (privateGroup !== undefined) privateTarget.caddyGroup = privateGroup
  if (privateInstance.accessLogRoot !== undefined) privateTarget.accessLogRoot = privateInstance.accessLogRoot
  return { public: publicTarget, private: privateTarget }
}
