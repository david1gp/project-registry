import { readFile } from "node:fs/promises"
import * as a from "valibot"
import { createResult, createResultError, type PromiseResult } from "#result"
import { caddyJsonObjectSchema, type CaddyJsonObject } from "./caddyJsonObjectSchema.js"

/** Read an immutable, full Caddy JSON baseline once at daemon open. */
export async function caddyConfigBaseRead(path: string): PromiseResult<CaddyJsonObject> {
  const op = "caddyConfigBaseRead"
  let input: unknown
  try {
    input = JSON.parse(await readFile(path, "utf8"))
  } catch {
    return createResultError(op, "Cannot read or parse preserved Caddy JSON configuration")
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return createResultError(op, "Preserved Caddy configuration must be a JSON object")
  }
  const parsed = a.safeParse(caddyJsonObjectSchema, input)
  if (!parsed.success) return createResultError(op, "Preserved Caddy configuration must be a JSON object")
  return createResult(parsed.output)
}
