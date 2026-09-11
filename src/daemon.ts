#!/usr/bin/env bun

import { projectRegistryVersion } from "./projectRegistryVersion.js"
import { projectRegistryVersionMetadataRender } from "./projectRegistryVersionMetadataRender.js"
import { projectRegistryDaemonConfigFromEnv } from "./runtime/projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonOpen } from "./runtime/projectRegistryDaemonOpen.js"

type ProjectRegistryDaemonRunOptions = {
  stdout?: (text: string) => void
  stderr?: (text: string) => void
}

export async function projectRegistryDaemonRun(
  args: readonly string[] = Bun.argv.slice(2),
  options: ProjectRegistryDaemonRunOptions = {},
): Promise<number> {
  const writeOut = options.stdout ?? ((text: string) => process.stdout.write(text))
  const writeError = options.stderr ?? ((text: string) => process.stderr.write(text))
  const versionRequested = args.includes("--version") || args[0] === "version"
  if (versionRequested) {
    writeOut(
      args.includes("--verbose")
        ? projectRegistryVersionMetadataRender("project-registryd")
        : `project-registryd ${projectRegistryVersion}\n`,
    )
    return 0
  }

  try {
    const configR = projectRegistryDaemonConfigFromEnv()
    if (!configR.success) {
      writeError(`project-registryd configuration error: ${configR.errorMessage}\n`)
      return 1
    }

    const daemonR = await projectRegistryDaemonOpen({ config: configR.data })
    if (!daemonR.success) {
      writeError(`project-registryd startup error: ${daemonR.errorMessage}\n`)
      return 1
    }

    const startR = await daemonR.data.start()
    if (!startR.success) {
      writeError(`project-registryd startup error: ${startR.errorMessage}\n`)
      const cleanupR = await daemonR.data.shutdown()
      if (!cleanupR.success) {
        writeError(`project-registryd shutdown error: ${cleanupR.errorMessage}\n`)
      }
      return 1
    }

    const terminationR = await daemonR.data.termination()
    if (!terminationR.success) {
      writeError(`project-registryd shutdown error: ${terminationR.errorMessage}\n`)
      return 1
    }
    return 0
  } catch {
    writeError("project-registryd unexpected failure\n")
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await projectRegistryDaemonRun()
}
