import { createHash } from "node:crypto"
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { createResult, createResultError } from "#result"
import type { LocalCertificateProvisioning } from "./LocalCertificateProvisioning.js"

type MkcertRun = (binary: string, args: string[]) => Promise<{ exitCode: number; stderr: string }>

function domainsNormalize(input: string[]): string[] | undefined {
  if (!Array.isArray(input) || input.length === 0 || input.some((domain) => typeof domain !== "string")) {
    return undefined
  }
  const domains = [...new Set(input.map((domain) => domain.trim().toLowerCase().replace(/\.+$/, "")))].sort()
  if (
    domains.some(
      (domain) =>
        domain.length > 253 ||
        !domain.includes(".") ||
        domain.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)),
    )
  ) {
    return undefined
  }
  return domains
}

export async function localCertificatesProvisionerProvision(
  stateDirectory: string,
  binary: string,
  run: MkcertRun,
  domainInput: string[],
): Promise<import("#result").Result<LocalCertificateProvisioning>> {
  const op = "localCertificatesProvision"
  const domains = domainsNormalize(domainInput)
  if (domains === undefined) return createResultError(op, "domains must be explicit normalized concrete DNS names")
  if (!isAbsolute(stateDirectory) || resolve(stateDirectory) !== stateDirectory || stateDirectory.includes("\0")) {
    return createResultError(op, "stateDirectory must be an absolute normalized path")
  }
  if (binary.trim() !== binary || binary.length === 0 || binary.includes("\0")) {
    return createResultError(op, "mkcert binary must be a non-empty command path")
  }
  const root = stateDirectory
  const key = createHash("sha256").update(JSON.stringify(domains)).digest("hex")
  const generationPath = join(root, `generation-${key}-${crypto.randomUUID()}`)
  const manifestPath = join(root, "current.json")
  try {
    await mkdir(root, { recursive: true, mode: 0o700 })
    await chmod(root, 0o700)
    try {
      const current: unknown = JSON.parse(await readFile(manifestPath, "utf8"))
      if (
        typeof current === "object" &&
        current !== null &&
        "domains" in current &&
        JSON.stringify(current.domains) === JSON.stringify(domains) &&
        "certificatePath" in current &&
        typeof current.certificatePath === "string" &&
        "privateKeyPath" in current &&
        typeof current.privateKeyPath === "string"
      ) {
        const [certificate, privateKey] = await Promise.all([stat(current.certificatePath), stat(current.privateKeyPath)])
        if (certificate.isFile() && privateKey.isFile() && (privateKey.mode & 0o077) === 0) {
          return createResult({
            domains,
            certificatePath: current.certificatePath,
            privateKeyPath: current.privateKeyPath,
            generationPath: "generationPath" in current && typeof current.generationPath === "string"
              ? current.generationPath
              : resolve(current.certificatePath, ".."),
            changed: false,
          })
        }
      }
    } catch {
      // Missing or invalid state triggers a new generation; existing published files are untouched.
    }
    await mkdir(generationPath, { mode: 0o700 })
    const stagedCertificate = join(generationPath, "certificate.pem")
    const stagedPrivateKey = join(generationPath, "private-key.pem")
    const command = await run(binary, ["-cert-file", stagedCertificate, "-key-file", stagedPrivateKey, ...domains])
    if (command.exitCode !== 0) {
      await rm(generationPath, { recursive: true, force: true })
      return createResultError(op, `mkcert failed (exit code ${command.exitCode})${command.stderr ? `: ${command.stderr.trim()}` : ""}`)
    }
    const [certificate, privateKey] = await Promise.all([stat(stagedCertificate), stat(stagedPrivateKey)])
    if (!certificate.isFile() || !privateKey.isFile()) throw new Error("mkcert did not produce a certificate/key pair")
    await chmod(stagedPrivateKey, 0o600)
    await chmod(stagedCertificate, 0o644)
    const published = {
      domains,
      certificatePath: stagedCertificate,
      privateKeyPath: stagedPrivateKey,
      generationPath,
    }
    const temporaryManifest = `${manifestPath}.${crypto.randomUUID()}.tmp`
    await writeFile(temporaryManifest, JSON.stringify(published), { encoding: "utf8", mode: 0o600, flag: "wx" })
    await chmod(temporaryManifest, 0o600)
    await rename(temporaryManifest, manifestPath)
    return createResult({ ...published, changed: true })
  } catch (error) {
    await rm(generationPath, { recursive: true, force: true }).catch(() => undefined)
    return createResultError(op, error instanceof Error ? error.message : "certificate provisioning failed", root)
  }
}
