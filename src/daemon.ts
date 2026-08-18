#!/usr/bin/env bun

import { projectRegistryDaemonConfigFromEnv } from "./runtime/projectRegistryDaemonConfigFromEnv.js"
import { projectRegistryDaemonOpen } from "./runtime/projectRegistryDaemonOpen.js"

export async function projectRegistryDaemonRun(): Promise<number> {
  try {
    const configR = projectRegistryDaemonConfigFromEnv()
    if (!configR.success) {
      process.stderr.write(`project-registryd configuration error: ${configR.errorMessage}\n`)
      return 1
    }

    const daemonR = await projectRegistryDaemonOpen({ config: configR.data })
    if (!daemonR.success) {
      process.stderr.write(`project-registryd startup error: ${daemonR.errorMessage}\n`)
      return 1
    }

    const startR = await daemonR.data.start()
    if (!startR.success) {
      process.stderr.write(`project-registryd startup error: ${startR.errorMessage}\n`)
      const cleanupR = await daemonR.data.shutdown()
      if (!cleanupR.success) {
        process.stderr.write(`project-registryd shutdown error: ${cleanupR.errorMessage}\n`)
      }
      return 1
    }

    const terminationR = await daemonR.data.termination()
    if (!terminationR.success) {
      process.stderr.write(`project-registryd shutdown error: ${terminationR.errorMessage}\n`)
      return 1
    }
    return 0
  } catch {
    process.stderr.write("project-registryd unexpected failure\n")
    return 1
  }
}

if (import.meta.main) {
  process.exitCode = await projectRegistryDaemonRun()
}
