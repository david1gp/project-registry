import { createResult } from "#result"
import type { LocalCertificateProvisioner } from "./LocalCertificateProvisioner.js"
import type { LocalCertificateProvisionerOptions } from "./LocalCertificateProvisionerOptions.js"
import { localCertificatesProvisionerProvision } from "./localCertificatesProvisionerProvision.js"

export function localCertificatesProvisionerCreate(
  options: LocalCertificateProvisionerOptions,
): LocalCertificateProvisioner {
  const binary = options.binary ?? "mkcert"
  const run = options.run ?? (async (command: string, args: string[]) => {
    try {
      const process = Bun.spawn([command, ...args], { stdout: "ignore", stderr: "pipe" })
      const stderr = await new Response(process.stderr).text()
      return { exitCode: await process.exited, stderr }
    } catch (error) {
      return { exitCode: 127, stderr: error instanceof Error ? error.message : "mkcert could not be started" }
    }
  })
  return {
    async provision(domains) {
      const result = await localCertificatesProvisionerProvision(options.stateDirectory, binary, run, domains)
      if (!result.success) return result
      return createResult(result.data)
    },
  }
}
