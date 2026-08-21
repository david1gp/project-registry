#!/usr/bin/env bun

import { chmod, writeFile } from "node:fs/promises"

type JsonRecord = Record<string, unknown>
const CADDY_ADMIN_CAPTURE_TIMEOUT_MS = 2_000

function loopbackHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase().replace(/^\[|\]$/g, "")
  if (normalizedHostname === "localhost" || normalizedHostname === "::1") return true

  const octets = normalizedHostname.split(".")
  if (octets.length !== 4 || octets[0] !== "127") return false
  return octets.every((octet) => /^\d+$/.test(octet) && Number(octet) <= 255)
}

function captureUrl(value: string): URL {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    throw new Error("--url must be a valid URL")
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("--url must use HTTP or HTTPS")
  }
  if (!loopbackHostname(url.hostname)) throw new Error("--url must target a loopback host")
  return url
}

function argumentValue(args: readonly string[], index: number, option: string): string {
  const value = args[index + 1]
  if (value === undefined || value.startsWith("--")) throw new Error(`${option} needs a value`)
  return value
}

function argumentsParse(args: readonly string[]): { output: string; url: string } {
  let output: string | undefined
  let url: string | undefined

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]
    if (argument === "--help" || argument === "-h") {
      console.log("Usage: bun run ops/migration/caddy-admin-config-capture.ts --url URL --output PATH")
      process.exit(0)
    }
    if (argument === "--url") {
      url = argumentValue(args, index, argument)
      index += 1
      continue
    }
    if (argument === "--output") {
      output = argumentValue(args, index, argument)
      index += 1
      continue
    }
    throw new Error(`unknown argument: ${argument}`)
  }

  if (url === undefined || url.trim() === "") throw new Error("--url is required")
  if (output === undefined || output.trim() === "") throw new Error("--output is required")
  return { output, url }
}

function jsonRecord(value: unknown): JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Caddy /config/ response must be a JSON object")
  }
  return value as JsonRecord
}

async function main(): Promise<void> {
  const { output, url: urlValue } = argumentsParse(process.argv.slice(2))
  const url = captureUrl(urlValue)
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), CADDY_ADMIN_CAPTURE_TIMEOUT_MS)
  let body: string
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal })
    if (!response.ok) throw new Error(`Caddy admin API returned HTTP ${response.status} ${response.statusText}`)
    body = await response.text()
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`Caddy admin API request timed out after ${CADDY_ADMIN_CAPTURE_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  const config = jsonRecord(JSON.parse(body))
  await writeFile(output, `${JSON.stringify(config, null, 2)}\n`, "utf8")
  await chmod(output, 0o600)
}

try {
  await main()
} catch (error) {
  console.error(`Caddy config capture failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
