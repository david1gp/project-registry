import { isIP } from "node:net"
import { dirname } from "node:path"
import { createResult, createResultError, type Result } from "#result"
import type { CaddyFetch } from "../caddy/CaddyFetch.js"
import type { ProjectRegistryDaemonServerIp } from "./ProjectRegistryDaemonServerIp.js"
import type { ProjectRegistryDaemonServerIpFilesystem } from "./ProjectRegistryDaemonServerIpFilesystem.js"
import type { ProjectRegistryDaemonServerIpLogger } from "./ProjectRegistryDaemonServerIpLogger.js"

const discoveryEndpoint = "https://api.ipify.org"
const cacheDirectoryMode = 0o700
const cacheFileMode = 0o600

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function ipIsValid(value: string): boolean {
  return isIP(value) !== 0
}

function loggerDefault(message: string): void {
  console.info(message)
}

function elapsedMilliseconds(startedAt: number, clock: () => number): number {
  return Math.max(0, clock() - startedAt)
}

export function projectRegistryDaemonServerIpCreate(options: {
  override?: string
  cachePath: string
  timeoutMs: number
  filesystem: ProjectRegistryDaemonServerIpFilesystem
  fetch: CaddyFetch
  logger?: ProjectRegistryDaemonServerIpLogger
  clock?: () => number
}): Result<ProjectRegistryDaemonServerIp> {
  const op = "projectRegistryDaemonServerIpCreate"
  if (typeof options !== "object" || options === null) return createResultError(op, "server IP options are required")
  if (options.override !== undefined && !ipIsValid(options.override)) {
    return createResultError(op, "SERVER_IP must be a valid IPv4 or IPv6 address")
  }
  if (typeof options.cachePath !== "string" || options.cachePath.length === 0) {
    return createResultError(op, "server IP cache path is required")
  }
  if (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1) {
    return createResultError(op, "server IP discovery timeout is invalid")
  }
  if (typeof options.filesystem !== "object" || options.filesystem === null) {
    return createResultError(op, "server IP filesystem is required")
  }
  if (typeof options.fetch !== "function") return createResultError(op, "server IP fetch is required")

  const filesystem = options.filesystem
  const fetch = options.fetch
  const logger = options.logger ?? loggerDefault
  const clock = options.clock ?? Date.now
  let current = options.override
  let started = false
  let stopped = false
  let controller: AbortController | undefined

  function log(message: string): void {
    try {
      logger(message)
    } catch {
      // Logging must not affect daemon startup or shutdown.
    }
  }

  async function cacheRead(): Promise<string | undefined> {
    try {
      const value = (await filesystem.readFile(options.cachePath)).trim()
      return ipIsValid(value) ? value : undefined
    } catch {
      return undefined
    }
  }

  async function cacheWrite(value: string): Promise<void> {
    const temporaryPath = `${options.cachePath}.tmp-${process.pid}`
    try {
      await filesystem.mkdir(dirname(options.cachePath), cacheDirectoryMode)
      await filesystem.writeFile(temporaryPath, `${value}\n`, cacheFileMode)
      await filesystem.rename(temporaryPath, options.cachePath)
    } catch (error) {
      try {
        await filesystem.unlink(temporaryPath)
      } catch {
        // Preserve the atomic write failure.
      }
      throw error
    }
  }

  async function refresh(startedAt: number): Promise<void> {
    let outcomeLogged = false
    const logOutcome = (outcome: string): void => {
      if (outcomeLogged) return
      outcomeLogged = true
      log(`server IP discovery outcome=${outcome} elapsedMs=${elapsedMilliseconds(startedAt, clock)}`)
    }

    try {
      const cached = await cacheRead()
      if (stopped) {
        logOutcome("cancelled")
        return
      }
      if (cached !== undefined) current = cached

      const activeController = controller
      if (activeController === undefined || activeController.signal.aborted) {
        logOutcome("cancelled")
        return
      }

      let timedOut = false
      const timeoutHandle = globalThis.setTimeout(() => {
        timedOut = true
        activeController.abort()
      }, options.timeoutMs)
      try {
        const response = await fetch(discoveryEndpoint, { signal: activeController.signal })
        if (!response.ok) throw new Error(`HTTP ${response.status}`)
        const value = (await response.text()).trim()
        if (!ipIsValid(value)) throw new Error("response was not a valid IPv4 or IPv6 address")
        if (stopped || activeController.signal.aborted) {
          logOutcome("cancelled")
          return
        }
        await cacheWrite(value)
        if (stopped || activeController.signal.aborted) {
          logOutcome("cancelled")
          return
        }
        current = value
        log(`server IP discovery outcome=success ip=${value} elapsedMs=${elapsedMilliseconds(startedAt, clock)}`)
        outcomeLogged = true
      } catch (error) {
        if (stopped) {
          logOutcome("cancelled")
          return
        }
        if (timedOut) {
          logOutcome("failure reason=timeout")
          return
        }
        if (activeController.signal.aborted) {
          logOutcome("cancelled")
          return
        }
        logOutcome(`failure reason=${errorMessage(error)}`)
      } finally {
        globalThis.clearTimeout(timeoutHandle)
      }
    } catch (error) {
      if (stopped) {
        logOutcome("cancelled")
        return
      }
      logOutcome(`failure reason=${errorMessage(error)}`)
    }
  }

  function start(): void {
    if (started || stopped) return
    started = true
    if (options.override !== undefined) return
    controller = new AbortController()
    const startedAt = clock()
    log(`server IP discovery started endpoint=${discoveryEndpoint}`)
    void refresh(startedAt).catch(() => undefined)
  }

  function shutdown(): void {
    stopped = true
    controller?.abort()
  }

  return createResult({ current: () => current, start, shutdown })
}
