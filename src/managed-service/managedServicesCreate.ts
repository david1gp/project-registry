import { createResult, createResultErrorCode, type PromiseResult, type Result } from "#result"
import type { Actor } from "../access/Actor.js"
import type { DevProcessRunner } from "../dev/DevProcessRunner.js"
import type { DevProjectFilesystem } from "../dev/DevProjectFilesystem.js"
import type { Project } from "../project/Project.js"
import type { ManagedServiceAction } from "./ManagedServiceAction.js"
import type { ManagedServiceConfig } from "./ManagedServiceConfig.js"
import type { ManagedServiceEntry } from "./ManagedServiceEntry.js"
import type { ManagedServiceFilesystem } from "./ManagedServiceFilesystem.js"
import type { ManagedServiceLogStreamer } from "./ManagedServiceLogStreamer.js"
import type { ManagedServiceStatus } from "./ManagedServiceStatus.js"
import type { ManagedServices, ManagedServiceTarget } from "./ManagedServices.js"
import { managedServiceAuditAppend } from "./managedServiceAuditAppend.js"
import { managedServiceAuthorize } from "./managedServiceAuthorize.js"
import { managedServiceEntriesList } from "./managedServiceEntriesList.js"
import { managedServiceLogsArgs } from "./managedServiceLogsArgs.js"
import { type ManagedServiceReconcileSummary, managedServiceReconcile } from "./managedServiceReconcile.js"
import { managedServiceSelect } from "./managedServiceSelect.js"
import { managedServiceStatusRead } from "./managedServiceStatusRead.js"
import { managedServiceSystemctl } from "./managedServiceSystemctl.js"

export type ManagedServicesCreateOptions = {
  config: ManagedServiceConfig
  projectsRead: () => PromiseResult<readonly Project[]>
  runner: DevProcessRunner
  filesystem: ManagedServiceFilesystem
  projectFilesystem: DevProjectFilesystem
  logStreamer: ManagedServiceLogStreamer
  clock?: () => number
  logger?: (message: string) => void
}

/**
 * Registry-managed permanent services: the reconcile queue plus the `svc`
 * verbs. Every entry point is gated by `config.enabled`; disabled, nothing is
 * read from or written to disk and no systemctl/journalctl runs.
 */
export function managedServicesCreate(options: ManagedServicesCreateOptions): ManagedServices {
  const { config, runner } = options
  const clock = options.clock ?? Date.now
  let running: Promise<Result<ManagedServiceReconcileSummary>> | undefined
  let pending: Promise<Result<ManagedServiceReconcileSummary>> | undefined
  let pendingStartup = false
  let last: Result<ManagedServiceReconcileSummary> | undefined

  function disabled<T>(op: string): Result<T> {
    return createResultErrorCode(op, "Managed services are disabled.", "services.disabled")
  }

  async function reconcileOnce(startup: boolean): Promise<Result<ManagedServiceReconcileSummary>> {
    const projectsR = await options.projectsRead()
    if (!projectsR.success) return projectsR
    const summaryR = await managedServiceReconcile({
      config,
      projects: projectsR.data,
      runner,
      filesystem: options.filesystem,
      projectFilesystem: options.projectFilesystem,
      startup,
    })
    if (summaryR.success) {
      const { written, removed, failures } = summaryR.data
      if (written.length > 0 || removed.length > 0 || failures.length > 0) {
        options.logger?.(
          `managed services: written=${written.join(",") || "-"} removed=${removed.join(",") || "-"} failures=${failures.join("; ") || "-"}`,
        )
      }
    }
    return summaryR
  }

  function reconcile(startup = false): PromiseResult<ManagedServiceReconcileSummary> {
    if (!config.enabled) return Promise.resolve(disabled("managedServicesReconcile"))
    if (running === undefined) {
      running = reconcileOnce(startup).finally(() => {
        running = undefined
      })
      void running.then((result) => {
        last = result
      })
      return running
    }
    // One follow-up pass covers every request that arrived mid-run.
    pendingStartup ||= startup
    if (pending === undefined) {
      pending = running.then(() => {
        pending = undefined
        const nextStartup = pendingStartup
        pendingStartup = false
        return reconcile(nextStartup)
      })
    }
    return pending
  }

  async function select(
    op: string,
    actor: Actor,
    target: ManagedServiceTarget,
    many: boolean,
  ): PromiseResult<ManagedServiceEntry[]> {
    if (!config.enabled) return disabled(op)
    const authorizationR = managedServiceAuthorize(actor, config.allowedUsers)
    if (!authorizationR.success) return authorizationR
    const projectsR = await options.projectsRead()
    if (!projectsR.success) return projectsR
    return managedServiceSelect(managedServiceEntriesList(projectsR.data), target.project, target.service, many)
  }

  async function act(
    actor: Actor,
    action: ManagedServiceAction,
    target: ManagedServiceTarget,
  ): PromiseResult<ManagedServiceStatus> {
    const op = "managedServicesAct"
    const selectedR = await select(op, actor, target, false)
    if (!selectedR.success) return selectedR
    const entry = selectedR.data[0]!
    // The unit file must exist before systemd can act on it.
    const reconcileR = await reconcile()
    if (!reconcileR.success) return reconcileR
    const { written, unchanged, failures } = reconcileR.data
    if (!written.includes(entry.unit) && !unchanged.includes(entry.unit)) {
      const failure = failures.find((line) => line.startsWith(`${entry.unit}:`)) ?? `${entry.unit}: unit not rendered`
      return createResultErrorCode(op, failure, "services.unavailable")
    }
    const actionR = await managedServiceSystemctl(runner, [action, entry.unit])
    const auditR = await managedServiceAuditAppend(options.filesystem, config.auditLogPath, {
      at: new Date(clock()).toISOString(),
      actor: actor.username,
      action,
      owner: entry.owner,
      project: entry.project,
      service: entry.serviceId,
      unit: entry.unit,
      success: actionR.success,
      ...(actionR.success ? {} : { error: actionR.errorMessage }),
    })
    // Fail closed: an action that cannot be audited is reported as failed
    // even though systemd already ran it.
    if (!auditR.success) return auditR
    if (!actionR.success) return actionR
    const statusR = await managedServiceStatusRead(runner, [entry])
    if (!statusR.success) return statusR
    return createResult(statusR.data[0]!)
  }

  return {
    enabled: config.enabled,
    reconcile,
    async status(actor, target) {
      const selectedR = await select("managedServicesStatus", actor, target, true)
      if (!selectedR.success) return selectedR
      return managedServiceStatusRead(runner, selectedR.data)
    },
    act,
    async logs(actor, target, lines, follow) {
      const selectedR = await select("managedServicesLogs", actor, target, false)
      if (!selectedR.success) return selectedR
      const spawned = options.logStreamer(managedServiceLogsArgs(selectedR.data[0]!.unit, lines, follow))
      return createResult({ stream: spawned.stdout, cancel: spawned.cancel })
    },
    lastReconcile: () => last,
  }
}
