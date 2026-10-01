import { createResult, type PromiseResult } from "#result"
import type { CaddyConfig } from "../caddy/CaddyConfig.js"
import { caddyConfigHostnames } from "../caddy/caddyConfigHostnames.js"
import type { LocalCertificateProvisioner } from "../local-certificates/LocalCertificateProvisioner.js"
import { localCertificatesProvisionerCreate } from "../local-certificates/localCertificatesProvisionerCreate.js"
import { hostsManagedBlockReconcile } from "../local-hosts/hostsManagedBlockReconcile.js"
import type { Project } from "../project/Project.js"
import type { LocalDomainsOptions } from "./localDomainsOptionsSchema.js"

/** Compose existing reconcilers; never install a CA or touch /etc/hosts. */
export function localDomainsCaddyConfigReconcileCreate(
  options: LocalDomainsOptions,
  provisioner: LocalCertificateProvisioner = localCertificatesProvisionerCreate({
    binary: options.mkcertBinary,
    stateDirectory: options.stateDirectory,
  }),
): (config: CaddyConfig, projects: readonly Project[]) => PromiseResult<CaddyConfig> {
  return async (config, _projects) => {
    // Inspect the merged config, never just Registry records: baseline sites need TLS too.
    const domains = caddyConfigHostnames(config)

    // Issue first: a failed issuance must not publish new hosts entries or reach Caddy.
    if (domains.length === 0) {
      const hostsR = await hostsManagedBlockReconcile(options.hostsFilePath, domains)
      if (!hostsR.success) return hostsR
      return createResult(config)
    }
    const certificatesR = await provisioner.provision(domains)
    if (!certificatesR.success) return certificatesR
    const hostsR = await hostsManagedBlockReconcile(options.hostsFilePath, domains)
    if (!hostsR.success) return hostsR

    const existingFiles = config.apps.tls?.certificates?.load_files ?? []
    const tags = [...new Set(existingFiles.flatMap((file) => file.tags ?? []))]

    return createResult({
      ...config,
      apps: {
        ...config.apps,
        tls: {
          ...config.apps.tls,
          certificates: {
            ...config.apps.tls?.certificates,
            load_files: [
              ...existingFiles,
              {
                certificate: certificatesR.data.certificatePath,
                key: certificatesR.data.privateKeyPath,
                ...(tags.length === 0 ? {} : { tags }),
              },
            ],
          },
        },
      },
    })
  }
}
