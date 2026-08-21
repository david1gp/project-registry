#!/usr/bin/env bun

import { stat } from "node:fs/promises"
import { connect } from "node:net"
import { dirname, resolve } from "node:path"

type JsonRecord = Record<string, unknown>

type FileReference = {
  kind: "browse template" | "file matcher root" | "static root"
  path: string
}

type ProxyReference = {
  dial: string
  host: string
  port: number
}

type DependencyReferences = {
  errors: string[]
  files: FileReference[]
  proxies: ProxyReference[]
}

type DependencyOptions = {
  allowMissingBackends: boolean
  allowMissingFilesystem: boolean
  accessCommand: string
  candidate: string
  caddyGroup?: string
  caddyUser: string
  workingDirectory: string
}

type UserIdentity = {
  groups: Set<number>
  uid: number
}

function dependencyRecord(value: unknown): JsonRecord | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as JsonRecord
}

function dependencyArgumentValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} needs a value`)
  return value
}

function dependencyArgumentsParse(args: readonly string[]): DependencyOptions | undefined {
  let allowMissingBackends = false
  let allowMissingFilesystem = false
  let accessCommand = process.env.CADDY_ACCESS_CHECK_COMMAND ?? "/usr/sbin/runuser"
  let candidate: string | undefined
  let caddyGroup = process.env.CADDY_GROUP?.trim() || undefined
  let caddyUser = process.env.CADDY_USER?.trim() || ""
  let workingDirectory = process.cwd()

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--help" || argument === "-h") return undefined
    if (argument === "--candidate") {
      candidate = dependencyArgumentValue(args, index, argument)
      index += 1
      continue
    }
    if (argument === "--allow-missing-backends") {
      allowMissingBackends = true
      continue
    }
    if (argument === "--allow-missing-filesystem") {
      allowMissingFilesystem = true
      continue
    }
    if (argument === "--caddy-access-command") {
      accessCommand = dependencyArgumentValue(args, index, argument)
      index += 1
      continue
    }
    if (argument === "--caddy-user") {
      caddyUser = dependencyArgumentValue(args, index, argument)
      index += 1
      continue
    }
    if (argument === "--caddy-group") {
      caddyGroup = dependencyArgumentValue(args, index, argument)
      index += 1
      continue
    }
    if (argument === "--caddy-working-directory") {
      workingDirectory = dependencyArgumentValue(args, index, argument)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }

  if (candidate === undefined || candidate.trim() === "") throw new Error("--candidate is required")
  return {
    allowMissingBackends,
    allowMissingFilesystem,
    accessCommand,
    candidate,
    ...(caddyGroup === undefined ? {} : { caddyGroup }),
    caddyUser,
    workingDirectory: resolve(workingDirectory),
  }
}

function dependencyUsage(): string {
  return `Usage:
  bun run ops/migration/caddy-dependency-preflight.ts --candidate PATH [options]

Options:
  --candidate PATH                 Generated candidate Caddy JSON
  --allow-missing-backends         Warn instead of failing for stopped loopback backends
  --allow-missing-filesystem       Warn instead of failing for missing/inaccessible filesystem paths
  --caddy-user USER                Caddy effective user (default: resolved CADDY_USER)
  --caddy-group GROUP              Caddy effective primary group (default: resolved CADDY_GROUP)
  --caddy-access-command PATH      Safe user-switch command (default: /usr/sbin/runuser; use none only for test/offline fallback)
  --caddy-working-directory PATH   Working directory for relative template paths (default: current directory)
  --help                           Show this help`
}

async function dependencyCandidateRead(path: string): Promise<JsonRecord> {
  let source: string
  try {
    source = await Bun.file(path).text()
  } catch {
    throw new Error(`unable to read candidate: ${path}`)
  }

  try {
    const value = JSON.parse(source)
    const record = dependencyRecord(value)
    if (record === undefined) throw new Error("candidate JSON must be an object")
    return record
  } catch (error) {
    if (error instanceof Error && error.message === "candidate JSON must be an object") throw error
    throw new Error(`invalid candidate JSON: ${path}`)
  }
}

function dependencyPathAdd(references: FileReference[], reference: FileReference): void {
  if (references.some((item) => item.kind === reference.kind && item.path === reference.path)) return
  references.push(reference)
}

function dependencyProxyAdd(references: ProxyReference[], reference: ProxyReference): void {
  if (references.some((item) => item.host === reference.host && item.port === reference.port)) return
  references.push(reference)
}

function dependencyLoopbackDialParse(dial: string): { host: string; port: number } | { invalid: string } | undefined {
  const bracketed = /^\[([^\]]+)\]:(\d+)$/.exec(dial)
  const unbracketed = /^([^:]+):(\d+)$/.exec(dial)
  const host = bracketed?.[1] ?? unbracketed?.[1]
  const portText = bracketed?.[2] ?? unbracketed?.[2]
  if (host === undefined || portText === undefined) {
    if (/^(?:\[::1\]|localhost|127\.0\.0\.1|::1)(?::|$)/i.test(dial)) return { invalid: dial }
    return undefined
  }

  const normalizedHost = host.toLowerCase().replace(/\.$/, "")
  if (!new Set(["localhost", "127.0.0.1", "::1"]).has(normalizedHost)) return undefined

  const port = Number(portText)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { invalid: dial }
  return { host: normalizedHost, port }
}

function dependencyReferencesWalk(value: unknown, references: DependencyReferences): void {
  if (Array.isArray(value)) {
    for (const item of value) dependencyReferencesWalk(item, references)
    return
  }

  const record = dependencyRecord(value)
  if (record === undefined) return

  if (record.handler === "vars") {
    if (typeof record.root !== "string") references.errors.push("vars handler has no string root")
    else dependencyPathAdd(references.files, { kind: "static root", path: record.root })
  }

  const file = dependencyRecord(record.file)
  if (file !== undefined && Object.hasOwn(file, "root")) {
    if (typeof file.root !== "string") references.errors.push("file matcher has no string root")
    else dependencyPathAdd(references.files, { kind: "file matcher root", path: file.root })
  }

  if (record.handler === "file_server" && Object.hasOwn(record, "browse")) {
    const browse = dependencyRecord(record.browse)
    const template = browse?.template_file
    if (template !== undefined && typeof template !== "string")
      references.errors.push("browse has no string template_file")
    else if (typeof template === "string" && template !== "")
      dependencyPathAdd(references.files, { kind: "browse template", path: template })
  }

  if (record.handler === "reverse_proxy") {
    if (!Array.isArray(record.upstreams)) references.errors.push("reverse_proxy has no upstreams")
    else {
      for (const upstream of record.upstreams) {
        const upstreamRecord = dependencyRecord(upstream)
        const dial = upstreamRecord?.dial
        if (typeof dial !== "string") {
          references.errors.push("reverse_proxy upstream has no string dial")
          continue
        }
        const parsed = dependencyLoopbackDialParse(dial)
        if (parsed === undefined) continue
        if ("invalid" in parsed) {
          references.errors.push(`invalid loopback proxy backend dial: ${dial}`)
          continue
        }
        dependencyProxyAdd(references.proxies, { dial, host: parsed.host, port: parsed.port })
      }
    }
  }

  for (const child of Object.values(record)) dependencyReferencesWalk(child, references)
}

async function dependencyUserIdentityRead(user: string): Promise<UserIdentity> {
  async function idRead(args: string[]): Promise<string> {
    const process = Bun.spawn(["id", ...args], { stderr: "ignore", stdout: "pipe" })
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
    if (exitCode !== 0) throw new Error(`unable to resolve Caddy user: ${user}`)
    return stdout.trim()
  }

  const uid = Number(await idRead(["-u", user]))
  const groups = (await idRead(["-G", user]))
    .split(/\s+/)
    .filter((value) => value !== "")
    .map(Number)
  if (!Number.isInteger(uid) || groups.some((value) => !Number.isInteger(value)))
    throw new Error(`unable to resolve Caddy user: ${user}`)
  return { groups: new Set(groups), uid }
}

function dependencyPermissionBits(mode: number, statUid: number, statGid: number, identity: UserIdentity): number {
  if (statUid === identity.uid) return (mode >> 6) & 7
  if (identity.groups.has(statGid)) return (mode >> 3) & 7
  return mode & 7
}

function dependencyPermissionMessage(
  path: string,
  mode: number,
  statUid: number,
  statGid: number,
  identity: UserIdentity,
  required: number,
): string | undefined {
  const bits = dependencyPermissionBits(mode, statUid, statGid, identity)
  if ((bits & required) === required) return undefined
  if (required === 1) return `not traversable by Caddy: ${path}`
  if (required === 4) return `not readable by Caddy: ${path}`
  return `not readable/traversable by Caddy: ${path}`
}

type DependencyAccessRunner = (operation: "read" | "traverse", path: string) => Promise<boolean>

type DependencyFileFailure = {
  message: string
  missingOrInaccessible: boolean
}

type DependencyCommandResult = {
  error?: string
  exitCode: number
  stdout: string
}

async function dependencyCommandRun(command: string, args: string[]): Promise<DependencyCommandResult> {
  try {
    const process = Bun.spawn([command, ...args], { stderr: "ignore", stdout: "pipe" })
    const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
    return { exitCode, stdout: stdout.trim() }
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error), exitCode: 127, stdout: "" }
  }
}

async function dependencyAccessRunner(
  options: DependencyOptions,
  identity: UserIdentity,
): Promise<DependencyAccessRunner | undefined> {
  if (options.accessCommand === "none") return undefined
  const identityArgs = [
    "-u",
    options.caddyUser,
    ...(options.caddyGroup === undefined ? [] : ["-g", options.caddyGroup]),
    "--",
    "id",
    "-u",
  ]
  const identityCheck = await dependencyCommandRun(options.accessCommand, identityArgs)
  if (identityCheck.error !== undefined)
    throw new Error(`Caddy access command unavailable: ${options.accessCommand} (${identityCheck.error})`)
  if (identityCheck.exitCode !== 0)
    throw new Error(
      `Caddy access command identity probe failed: ${options.accessCommand} exited with ${identityCheck.exitCode}`,
    )
  if (!/^\d+$/.test(identityCheck.stdout))
    throw new Error(`Caddy access command identity probe returned invalid UID: ${identityCheck.stdout || "<empty>"}`)

  const probedUid = Number(identityCheck.stdout)
  if (!Number.isSafeInteger(probedUid) || probedUid !== identity.uid)
    throw new Error(
      `Caddy access command identity mismatch: expected UID ${identity.uid}, got ${identityCheck.stdout} for ${options.caddyUser}`,
    )

  return async (operation, path) => {
    const result = await dependencyCommandRun(options.accessCommand, [
      "-u",
      options.caddyUser,
      ...(options.caddyGroup === undefined ? [] : ["-g", options.caddyGroup]),
      "--",
      "test",
      operation === "read" ? "-r" : "-x",
      path,
    ])
    if (result.error !== undefined)
      throw new Error(`Caddy access command unavailable: ${options.accessCommand} (${result.error})`)
    return result.exitCode === 0
  }
}

async function dependencyFileCheck(
  reference: FileReference,
  options: DependencyOptions,
  identity: UserIdentity,
  accessRunner: DependencyAccessRunner | undefined,
): Promise<DependencyFileFailure | undefined> {
  const path = resolve(options.workingDirectory, reference.path)
  const ancestors: string[] = []
  let current = dirname(path)
  while (true) {
    ancestors.unshift(current)
    const parent = dirname(current)
    if (parent === current) break
    current = parent
  }

  for (const ancestor of ancestors) {
    let ancestorStat: Awaited<ReturnType<typeof stat>>
    try {
      ancestorStat = await stat(ancestor)
    } catch {
      return { message: `${reference.kind} path is absent or inaccessible: ${ancestor}`, missingOrInaccessible: true }
    }
    if (!ancestorStat.isDirectory())
      return { message: `${reference.kind} ancestor is not a directory: ${ancestor}`, missingOrInaccessible: false }
    if (accessRunner !== undefined) {
      if (!(await accessRunner("traverse", ancestor)))
        return { message: `not traversable by Caddy: ${ancestor}`, missingOrInaccessible: true }
      continue
    }
    const permission = dependencyPermissionMessage(
      ancestor,
      ancestorStat.mode,
      ancestorStat.uid,
      ancestorStat.gid,
      identity,
      1,
    )
    if (permission !== undefined) return { message: permission, missingOrInaccessible: true }
  }

  let targetStat: Awaited<ReturnType<typeof stat>>
  try {
    targetStat = await stat(path)
  } catch {
    return { message: `${reference.kind} is absent or inaccessible: ${path}`, missingOrInaccessible: true }
  }

  if (reference.kind === "browse template") {
    if (!targetStat.isFile())
      return { message: `browse template is not a regular file: ${path}`, missingOrInaccessible: false }
    if (accessRunner !== undefined) {
      if (!(await accessRunner("read", path)))
        return { message: `not readable by Caddy: ${path}`, missingOrInaccessible: true }
      return undefined
    }
    const permission = dependencyPermissionMessage(path, targetStat.mode, targetStat.uid, targetStat.gid, identity, 4)
    return permission === undefined ? undefined : { message: permission, missingOrInaccessible: true }
  }

  if (!targetStat.isDirectory())
    return { message: `${reference.kind} is not a directory: ${path}`, missingOrInaccessible: false }
  if (accessRunner !== undefined) {
    if (!(await accessRunner("read", path)) || !(await accessRunner("traverse", path)))
      return { message: `not readable/traversable by Caddy: ${path}`, missingOrInaccessible: true }
    return undefined
  }
  const permission = dependencyPermissionMessage(path, targetStat.mode, targetStat.uid, targetStat.gid, identity, 5)
  return permission === undefined ? undefined : { message: permission, missingOrInaccessible: true }
}

function dependencyProxyConnect(reference: ProxyReference): Promise<boolean> {
  return new Promise((resolveResult) => {
    const host = reference.host === "localhost" ? "127.0.0.1" : reference.host
    let settled = false
    const socket = connect({ host, port: reference.port })
    const finish = (connected: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolveResult(connected)
    }
    socket.once("connect", () => finish(true))
    socket.once("error", () => finish(false))
    socket.setTimeout(750, () => finish(false))
  })
}

async function dependencyPreflightRun(options: DependencyOptions): Promise<{ failures: string[]; warnings: string[] }> {
  const candidate = await dependencyCandidateRead(options.candidate)
  const references: DependencyReferences = { errors: [], files: [], proxies: [] }
  dependencyReferencesWalk(candidate, references)
  const failures = [...references.errors]
  const warnings: string[] = []
  let accessRunner: DependencyAccessRunner | undefined

  if (references.files.length > 0) {
    if (options.caddyUser === "") throw new Error("--caddy-user or resolved CADDY_USER is required")
    const identity = await dependencyUserIdentityRead(options.caddyUser)
    accessRunner = await dependencyAccessRunner(options, identity)
    const fileFailures = await Promise.all(
      references.files.map((reference) => dependencyFileCheck(reference, options, identity, accessRunner)),
    )
    for (const failure of fileFailures) {
      if (failure === undefined) continue
      if (options.allowMissingFilesystem && failure.missingOrInaccessible) warnings.push(failure.message)
      else failures.push(failure.message)
    }
  }

  const proxyResults = await Promise.all(
    references.proxies.map(async (reference) => ({ reference, listening: await dependencyProxyConnect(reference) })),
  )
  for (const result of proxyResults) {
    if (!result.listening) {
      const message = `proxy backend is not listening: ${result.reference.dial}`
      if (options.allowMissingBackends) warnings.push(message)
      else failures.push(message)
    }
  }

  const sort = (values: string[]) => values.sort((left, right) => (left === right ? 0 : left < right ? -1 : 1))
  return { failures: sort(failures), warnings: sort(warnings) }
}

if (import.meta.main) {
  let options: DependencyOptions | undefined
  try {
    options = dependencyArgumentsParse(process.argv.slice(2))
  } catch (error) {
    console.error(`dependency preflight failed: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 2
  }

  if (options === undefined && process.argv.slice(2).some((argument) => argument === "--help" || argument === "-h")) {
    console.log(dependencyUsage())
  } else if (options !== undefined) {
    try {
      const result = await dependencyPreflightRun(options)
      for (const warning of result.warnings) console.error(`dependency preflight warning: ${warning}`)
      if (result.failures.length > 0) {
        console.error("dependency preflight failed:")
        for (const failure of result.failures) console.error(`- ${failure}`)
        process.exitCode = 1
      } else {
        console.log("dependency preflight: PASS")
      }
    } catch (error) {
      console.error(`dependency preflight failed: ${error instanceof Error ? error.message : String(error)}`)
      process.exitCode = 1
    }
  }
}
