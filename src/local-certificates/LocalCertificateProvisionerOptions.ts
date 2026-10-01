export type LocalCertificateProvisionerOptions = {
  binary?: string
  stateDirectory: string
  run?: (binary: string, args: string[]) => Promise<{ exitCode: number; stderr: string }>
}
