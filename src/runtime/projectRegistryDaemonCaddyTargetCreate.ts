import { createResult, type PromiseResult } from "#result"
import type { CaddyApplicationTarget } from "../caddy/CaddyApplicationTarget.js"
import type { CaddyConfig } from "../caddy/CaddyConfig.js"
import { caddyConfigBaseMerge } from "../caddy/caddyConfigBaseMerge.js"
import { caddyConfigBaseRead } from "../caddy/caddyConfigBaseRead.js"
import { caddyConfigPrivateTlsReconcileCreate } from "../caddy/caddyConfigPrivateTlsReconcile.js"
import type { CaddyInstanceTarget } from "../caddy/caddyInstanceTargetsResolve.js"
import { localDomainsCaddyConfigReconcileCreate } from "../local-domains/localDomainsCaddyConfigReconcileCreate.js"
import type { ProjectPrivateTlsGateSnapshot } from "../project/projectPrivateTlsGate.js"
import type { ProjectRegistryDaemonConfig } from "./ProjectRegistryDaemonConfig.js"

/** Baselines are loaded once, independently; running configs are never inferred as baselines. */
export async function projectRegistryDaemonCaddyTargetCreate(
  target: CaddyInstanceTarget,
  config: ProjectRegistryDaemonConfig,
  options?: {
    privateTls?: {
      enabled: boolean
      snapshotCurrent: () => ProjectPrivateTlsGateSnapshot
      privateListenerAddresses?: readonly unknown[]
    }
  },
): PromiseResult<CaddyApplicationTarget> {
  const baseR =
    target.baseConfigPath === undefined ? createResult(undefined) : await caddyConfigBaseRead(target.baseConfigPath)
  if (!baseR.success) return baseR
  const localReconcile =
    config.localDomains === undefined ? undefined : localDomainsCaddyConfigReconcileCreate(config.localDomains)
  const privateTlsR =
    options?.privateTls === undefined
      ? createResult(undefined)
      : caddyConfigPrivateTlsReconcileCreate({
          enabled: options.privateTls.enabled,
          snapshotCurrent: options.privateTls.snapshotCurrent,
          ...(options.privateTls.privateListenerAddresses === undefined
            ? {}
            : { privateListenerAddresses: options.privateTls.privateListenerAddresses }),
        })
  if (!privateTlsR.success) return privateTlsR
  const privateTlsReconcile = privateTlsR.data

  return createResult({
    adminUrl: target.adminUrl,
    caddyBin: config.caddyBinary,
    configOptions: {
      httpsListeners: target.httpsListeners,
      oidc: config.oidc,
      ...(target.accessLogRoot === undefined ? {} : { caddyAccessLogRoot: target.accessLogRoot }),
    },
    ...(baseR.data === undefined && localReconcile === undefined && privateTlsReconcile === undefined
      ? {}
      : {
          configReconcile: async (generated, projects) => {
            // No imported route ownership/replacement authority is inferred.
            const mergedR = caddyConfigBaseMerge(generated, { baseConfig: baseR.data })
            if (!mergedR.success) return mergedR
            let merged = mergedR.data as unknown as CaddyConfig
            if (privateTlsReconcile !== undefined) {
              const tlsR = await privateTlsReconcile(merged, projects)
              if (!tlsR.success) return tlsR
              merged = tlsR.data
            }
            return localReconcile === undefined ? createResult(merged) : localReconcile(merged, projects)
          },
        }),
  })
}
