export type LocalCertificateProvisioner = {
  provision(domains: string[]): Promise<import("#result").Result<import("./LocalCertificateProvisioning.js").LocalCertificateProvisioning>>
}
