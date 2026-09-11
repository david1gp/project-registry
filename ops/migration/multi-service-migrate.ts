#!/usr/bin/env bun

import { createResult, createResultError, type Result } from "@adaptive-ds/result"
import { projectRepositoryLeoServiceGroupings } from "../../src/project-store/projectRepositoryLeoServiceGroupings.ts"
import { projectRepositoryOpen } from "../../src/project-store/projectRepositoryOpen.ts"

type MigrationArguments = {
  apply: boolean
  actor: string
  json: boolean
  repository: string
}

function argumentValue(args: readonly string[], index: number, option: string): Result<string> {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--"))
    return createResultError("multiServiceMigrationArguments", `${option} needs a value`)
  return createResult(value)
}

function argumentsParse(args: readonly string[]): Result<MigrationArguments> {
  let apply = false
  let dryRun = false
  let actor = "project-registry"
  let json = false
  let repository: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--apply") {
      apply = true
      continue
    }
    if (argument === "--dry-run") {
      dryRun = true
      continue
    }
    if (argument === "--json") {
      json = true
      continue
    }
    if (argument === "--repository" || argument === "--actor") {
      const valueR = argumentValue(args, index, argument)
      if (!valueR.success) return valueR
      index += 1
      if (argument === "--repository") repository = valueR.data
      if (argument === "--actor") actor = valueR.data
      continue
    }
    return createResultError("multiServiceMigrationArguments", `unknown argument: ${argument}`)
  }

  if (apply && dryRun)
    return createResultError("multiServiceMigrationArguments", "--apply and --dry-run are mutually exclusive")
  if (repository === undefined || repository.trim() === "") {
    return createResultError("multiServiceMigrationArguments", "--repository is required")
  }
  return createResult({ apply, actor, json, repository })
}

function errorWrite(error: Extract<Result<never>, { success: false }>, json: boolean): void {
  if (json) {
    process.stderr.write(`${JSON.stringify({ success: false, op: error.op, errorMessage: error.errorMessage })}\n`)
    return
  }
  process.stderr.write(`${error.errorMessage}\n`)
}

const argumentsR = argumentsParse(Bun.argv.slice(2))
if (!argumentsR.success) {
  errorWrite(argumentsR, false)
  process.exitCode = 2
} else {
  const options = argumentsR.data
  const repositoryR = await projectRepositoryOpen({ dir: options.repository })
  if (!repositoryR.success) {
    errorWrite(repositoryR, options.json)
    process.exitCode = 1
  } else {
    const migrationR = await repositoryR.data.migrate({
      actor: options.actor,
      dryRun: !options.apply,
      groupings: projectRepositoryLeoServiceGroupings,
    })
    if (!migrationR.success) {
      errorWrite(migrationR, options.json)
      process.exitCode = 1
    } else {
      process.stdout.write(`${JSON.stringify(migrationR.data)}\n`)
    }
  }
}
