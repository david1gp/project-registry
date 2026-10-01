import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, test } from "bun:test"
import { localCertificatesProvisionerCreate } from "./localCertificatesProvisionerCreate.js"

test("certificate provisioning normalizes domains and reuses paths until the domain set changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-certificates-"))
  const calls: string[][] = []
  const provisioner = localCertificatesProvisionerCreate({
    stateDirectory: join(root, "state"),
    binary: "/test/mkcert",
    run: async (_binary, args) => {
      calls.push(args)
      await writeFile(args[1]!, "certificate")
      await writeFile(args[3]!, "private key")
      return { exitCode: 0, stderr: "" }
    },
  })
  try {
    const first = await provisioner.provision(["B.Example.test.", "a.example.test"])
    expect(first.success).toBe(true)
    if (!first.success) return
    expect(first.data.domains).toEqual(["a.example.test", "b.example.test"])
    expect((await stat(first.data.privateKeyPath)).mode & 0o777).toBe(0o600)
    const unchanged = await provisioner.provision(["a.example.test", "b.example.test"])
    expect(unchanged.success && unchanged.data.changed).toBe(false)
    expect(unchanged.success && unchanged.data.certificatePath).toBe(first.data.certificatePath)
    expect(calls).toHaveLength(1)

    const changed = await provisioner.provision(["a.example.test"])
    expect(changed.success && changed.data.changed).toBe(true)
    expect(changed.success && changed.data.generationPath).not.toBe(first.data.generationPath)
    expect(calls).toHaveLength(2)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test("failed mkcert run does not replace the last published certificate pair", async () => {
  const root = await mkdtemp(join(tmpdir(), "registry-certificates-failure-"))
  const stateDirectory = join(root, "state")
  let fail = false
  const provisioner = localCertificatesProvisionerCreate({
    stateDirectory,
    run: async (_binary, args) => {
      if (fail) return { exitCode: 1, stderr: "injected failure" }
      await writeFile(args[1]!, "certificate")
      await writeFile(args[3]!, "private key")
      return { exitCode: 0, stderr: "" }
    },
  })
  try {
    const first = await provisioner.provision(["one.example.test"])
    expect(first.success).toBe(true)
    if (!first.success) return
    const previousManifest = await readFile(join(stateDirectory, "current.json"), "utf8")
    fail = true
    const failed = await provisioner.provision(["two.example.test"])
    expect(failed.success).toBe(false)
    expect(await readFile(join(stateDirectory, "current.json"), "utf8")).toBe(previousManifest)
    expect(await readFile(first.data.certificatePath, "utf8")).toBe("certificate")
    expect(await readFile(first.data.privateKeyPath, "utf8")).toBe("private key")
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
