import { createResult, createResultError, type PromiseResult, type Result } from "#result"
import type { CloudflareDnsFetch } from "../cloudflare/CloudflareDnsFetch.js"
import { cloudflareDnsReconcile } from "../cloudflare/cloudflareDnsReconcile.js"
import type { Project } from "../project/Project.js"
import { projectDomainNormalize } from "../project/projectDomainNormalize.js"

const reconcileIntervalMs = 1_000

type ProjectCreateOptions = {
  noDns: boolean
}

export function projectRegistryDaemonCloudflareDnsCreate(options: {
  enabled: boolean
  token?: string
  timeoutMs: number
  serverIpCurrent: () => string | undefined
  timer: {
    setInterval(callback: () => void, delayMs: number): unknown
    clearInterval(handle: unknown): void
  }
  fetch?: CloudflareDnsFetch
}): Result<{
  start(): Result<void>
  shutdown(): PromiseResult<void>
  projectCreateAfterPersistence(project: Project, options: ProjectCreateOptions): void
}> {
  const op = "projectRegistryDaemonCloudflareDnsCreate"
  if (typeof options !== "object" || options === null)
    return createResultError(op, "Cloudflare DNS options are required")
  if (typeof options.enabled !== "boolean") return createResultError(op, "Cloudflare DNS enabled flag is invalid")
  if (options.token !== undefined && (typeof options.token !== "string" || options.token.trim() !== options.token)) {
    return createResultError(op, "Cloudflare API token is invalid")
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    return createResultError(op, "Cloudflare DNS timeout is invalid")
  }
  if (typeof options.serverIpCurrent !== "function") return createResultError(op, "server IP accessor is required")

  const active = options.enabled && options.token !== undefined && options.token.length > 0
  const pending = new Set<string>()
  const controller = new AbortController()
  let started = false
  let stopped = false
  let intervalHandle: unknown
  let drainPromise: Promise<void> | undefined
  let shutdownPromise: PromiseResult<void> | undefined

  function hostnames(project: Project): string[] {
    const values = new Set<string>()
    for (const domain of project.caddy?.domains ?? []) {
      const normalized = projectDomainNormalize(domain)
      if (normalized !== "") values.add(normalized)
    }
    return [...values]
  }

  async function drain(): Promise<void> {
    if (!active || !started || stopped) return
    const address = options.serverIpCurrent()
    if (address === undefined || address === "") return

    for (const hostname of [...pending]) {
      if (stopped) return
      pending.delete(hostname)
      try {
        await cloudflareDnsReconcile({
          token: options.token!,
          hostname,
          address,
          timeoutMs: options.timeoutMs,
          signal: controller.signal,
          ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
        })
      } catch {
        // Remote DNS failures are deliberately nonfatal to project creation.
      }
    }
  }

  function drainSchedule(): void {
    if (!active || !started || stopped || drainPromise !== undefined) return
    const current = Promise.resolve()
      .then(drain)
      .catch(() => undefined)
    drainPromise = current
    void current.then(() => {
      if (drainPromise !== current) return
      drainPromise = undefined
      if (pending.size > 0 && !stopped && options.serverIpCurrent() !== undefined) drainSchedule()
    })
  }

  function start(): Result<void> {
    if (started) return createResult(undefined)
    if (stopped) return createResultError(op, "Cloudflare DNS queue has stopped")
    if (active) {
      try {
        intervalHandle = options.timer.setInterval(drainSchedule, reconcileIntervalMs)
      } catch {
        return createResultError(op, "Cloudflare DNS timer setup failed")
      }
    }
    started = true
    drainSchedule()
    return createResult(undefined)
  }

  function shutdown(): PromiseResult<void> {
    if (shutdownPromise !== undefined) return shutdownPromise
    stopped = true
    controller.abort()
    if (intervalHandle !== undefined) {
      try {
        options.timer.clearInterval(intervalHandle)
      } catch {
        // Queue cancellation continues even when timer cleanup fails.
      }
      intervalHandle = undefined
    }
    pending.clear()
    const current = drainPromise
    const wait = current === undefined ? Promise.resolve() : current
    shutdownPromise = wait.then(
      () => createResult(undefined),
      () => createResultError(op, "Cloudflare DNS queue shutdown failed"),
    )
    return shutdownPromise
  }

  function projectCreateAfterPersistence(project: Project, createOptions: ProjectCreateOptions): void {
    if (!active || !started || stopped || createOptions.noDns) return
    for (const hostname of hostnames(project)) pending.add(hostname)
    drainSchedule()
  }

  return createResult({ start, shutdown, projectCreateAfterPersistence })
}
