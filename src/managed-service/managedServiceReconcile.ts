import { join } from "node:path"
import { createResult, type PromiseResult } from "#result"
import type { DevProcessRunner } from "../dev/DevProcessRunner.js"
import type { DevProjectFilesystem } from "../dev/DevProjectFilesystem.js"
import type { Project } from "../project/Project.js"
import type { ManagedServiceConfig } from "./ManagedServiceConfig.js"
import type { ManagedServiceFilesystem } from "./ManagedServiceFilesystem.js"
import { managedServiceCommandResolve } from "./managedServiceCommandResolve.js"
import { managedServiceEntriesList } from "./managedServiceEntriesList.js"
import { managedServiceSystemctl } from "./managedServiceSystemctl.js"
import { managedServiceUnitMarker } from "./managedServiceUnitMarker.js"
import { managedServiceUnitRender } from "./managedServiceUnitRender.js"

const managedUnitFilePattern = /^proj-[a-z0-9][a-z0-9-]*\.service$/

export type ManagedServiceReconcileSummary = {
  written: string[]
  removed: string[]
  started: string[]
  unchanged: string[]
  /** `<unit or owner/project/service>: <reason>`; reconcile continues past each. */
  failures: string[]
}

export type ManagedServiceReconcileOptions = {
  config: ManagedServiceConfig
  projects: readonly Project[]
  runner: DevProcessRunner
  filesystem: ManagedServiceFilesystem
  projectFilesystem: DevProjectFilesystem
  /** Daemon start: also enable+start unchanged autostart units. */
  startup?: boolean
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Converge `<unitDirectory>/proj-*.service` to the registry rows. Disabled
 * config is a strict no-op (no reads, writes, or systemctl calls). Changed
 * units are written atomically, one daemon-reload covers all writes and
 * removals, changed autostart units are enabled and restarted (unchanged
 * ones only started at daemon start), changed non-autostart units are
 * disabled (never stopped), and marker-bearing units whose row or definition vanished
 * are stopped, disabled, and deleted. Files without the marker are never
 * touched. A row that fails to resolve keeps its existing unit untouched.
 */
export async function managedServiceReconcile(
  options: ManagedServiceReconcileOptions,
): PromiseResult<ManagedServiceReconcileSummary> {
  const summary: ManagedServiceReconcileSummary = { written: [], removed: [], started: [], unchanged: [], failures: [] }
  const { config, runner, filesystem } = options
  if (!config.enabled) return createResult(summary)

  const listed = managedServiceEntriesList(options.projects)
  for (const unit of listed.conflicts) summary.failures.push(`${unit}: claimed by more than one owner`)
  for (const label of listed.invalid) summary.failures.push(`${label}: managed service needs a registry port`)

  let existingNames: string[]
  try {
    existingNames = (await filesystem.list(config.unitDirectory)).filter((name) => managedUnitFilePattern.test(name))
  } catch (error) {
    summary.failures.push(`${config.unitDirectory}: ${failureMessage(error)}`)
    return createResult(summary)
  }

  // Units that should exist (or must be kept because their row failed to
  // resolve or collides): removal never touches these.
  const keep = new Set<string>(listed.conflicts)
  const changed = new Set<string>()
  for (const entry of listed.entries) {
    keep.add(entry.unit)
    const path = join(config.unitDirectory, entry.unit)
    const commandR = await managedServiceCommandResolve({
      entry,
      projectsRoot: config.projectsRoot,
      filesystem: options.projectFilesystem,
    })
    if (!commandR.success) {
      summary.failures.push(`${entry.unit}: ${commandR.errorMessage}`)
      continue
    }
    const renderR = managedServiceUnitRender({
      owner: entry.owner,
      project: entry.project,
      service: entry.serviceId,
      user: config.user,
      group: config.group,
      homeDirectory: config.homeDirectory,
      projectsRoot: config.projectsRoot,
      workingDirectory: commandR.data.workingDirectory,
      slice: config.slice,
      pathValue: config.pathValue,
      port: entry.port,
      domains: entry.domains,
      ...(commandR.data.envFile === undefined ? {} : { envFile: commandR.data.envFile }),
      command: commandR.data.command,
      args: commandR.data.args,
    })
    if (!renderR.success) {
      summary.failures.push(`${entry.unit}: ${renderR.errorMessage}`)
      continue
    }
    try {
      const current = await filesystem.read(path)
      if (current !== undefined && !current.startsWith(managedServiceUnitMarker)) {
        summary.failures.push(`${entry.unit}: an unmanaged unit with this name exists`)
        continue
      }
      if (current === renderR.data) {
        summary.unchanged.push(entry.unit)
        continue
      }
      await filesystem.writeAtomic(path, renderR.data)
      summary.written.push(entry.unit)
      changed.add(entry.unit)
    } catch (error) {
      summary.failures.push(`${entry.unit}: ${failureMessage(error)}`)
    }
  }

  const stale: string[] = []
  for (const name of existingNames) {
    if (keep.has(name)) continue
    try {
      const content = await filesystem.read(join(config.unitDirectory, name))
      if (content?.startsWith(managedServiceUnitMarker)) stale.push(name)
    } catch (error) {
      summary.failures.push(`${name}: ${failureMessage(error)}`)
    }
  }
  for (const unit of stale) {
    // Stop+disable before deletion so no enablement symlink dangles.
    const disableR = await managedServiceSystemctl(runner, ["disable", "--now", unit], true)
    if (!disableR.success) summary.failures.push(`${unit}: ${disableR.errorMessage}`)
    try {
      await filesystem.remove(join(config.unitDirectory, unit))
      summary.removed.push(unit)
    } catch (error) {
      summary.failures.push(`${unit}: ${failureMessage(error)}`)
    }
  }

  if (summary.written.length > 0 || summary.removed.length > 0) {
    const reloadR = await managedServiceSystemctl(runner, ["daemon-reload"])
    if (!reloadR.success) {
      summary.failures.push(`daemon-reload: ${reloadR.errorMessage}`)
      return createResult(summary)
    }
  }

  for (const entry of listed.entries) {
    const written = changed.has(entry.unit)
    // Unchanged units are left alone except at daemon start, so a manual
    // `svc stop`/`svc disable` survives unrelated registry mutations.
    if (!written && !(options.startup === true && summary.unchanged.includes(entry.unit))) continue
    if (!entry.managed.autostart) {
      // Not wanted at boot: drop the enablement of a changed definition but
      // never stop a unit an operator started by hand (`svc start`).
      if (!written) continue
      const disableR = await managedServiceSystemctl(runner, ["disable", entry.unit])
      if (!disableR.success) summary.failures.push(`${entry.unit}: ${disableR.errorMessage}`)
      continue
    }
    const enableR = await managedServiceSystemctl(runner, ["enable", entry.unit])
    if (!enableR.success) {
      summary.failures.push(`${entry.unit}: ${enableR.errorMessage}`)
      continue
    }
    // A changed definition restarts so the new ExecStart/env applies; at
    // startup an unchanged one only starts (no-op when already running).
    const startR = await managedServiceSystemctl(runner, [written ? "restart" : "start", entry.unit])
    if (!startR.success) summary.failures.push(`${entry.unit}: ${startR.errorMessage}`)
    else summary.started.push(entry.unit)
  }
  return createResult(summary)
}
