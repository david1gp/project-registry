import { types } from "node:util"
import { createResult, createResultError, type Result } from "#result"

function caddyConfigSerializeValue(value: unknown, active: Set<object>): string {
  if (value === null) return "null"

  switch (typeof value) {
    case "string": {
      const serialized = JSON.stringify(value)
      if (serialized === undefined) throw new Error("unsupported string")
      return serialized
    }
    case "boolean":
      return value ? "true" : "false"
    case "number": {
      if (!Number.isFinite(value)) throw new Error("non-finite number")
      const serialized = JSON.stringify(value)
      if (serialized === undefined) throw new Error("unsupported number")
      return serialized
    }
    default:
      if (typeof value !== "object") throw new Error("unsupported value")
  }

  if (types.isProxy(value)) throw new Error("proxy value")
  if (active.has(value)) throw new Error("cyclic configuration")

  const prototype = Object.getPrototypeOf(value)
  if (Array.isArray(value)) {
    if (prototype !== Array.prototype) throw new Error("custom array prototype")
    return caddyConfigSerializeArray(value, active)
  }
  if (prototype !== Object.prototype) throw new Error("custom object prototype")

  return caddyConfigSerializeObject(value, active)
}

function caddyConfigSerializeArray(value: object[], active: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key === "symbol")) throw new Error("symbol property")

  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length")
  if (
    lengthDescriptor === undefined ||
    !("value" in lengthDescriptor) ||
    !Number.isInteger(lengthDescriptor.value) ||
    lengthDescriptor.value < 0
  ) {
    throw new Error("invalid array length")
  }

  const length = lengthDescriptor.value
  const indexes = new Set<number>()
  for (const key of ownKeys) {
    if (key === "length") continue
    if (!caddyConfigSerializeArrayIndexIsValid(key, length)) throw new Error("non-index array property")
    indexes.add(Number(key))
    const descriptor = Object.getOwnPropertyDescriptor(value, key)
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error("accessor or hidden property")
    }
  }

  const serialized: string[] = []
  active.add(value)
  try {
    for (let index = 0; index < length; index += 1) {
      if (!indexes.has(index)) throw new Error("sparse array")
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("accessor or hidden property")
      }
      serialized[index] = caddyConfigSerializeValue(descriptor.value, active)
    }
  } finally {
    active.delete(value)
  }

  return `[${serialized.join(",")}]`
}

function caddyConfigSerializeArrayIndexIsValid(key: string | symbol, length: number): boolean {
  if (typeof key !== "string" || key === "") return false
  const index = Number(key)
  return Number.isInteger(index) && index >= 0 && index < 2 ** 32 - 1 && index < length && String(index) === key
}

function caddyConfigSerializeObject(value: object, active: Set<object>): string {
  const ownKeys = Reflect.ownKeys(value)
  if (ownKeys.some((key) => typeof key === "symbol")) throw new Error("symbol property")

  const serialized: string[] = []
  active.add(value)
  try {
    for (const key of ownKeys.filter((item): item is string => typeof item === "string").sort()) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key)
      if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
        throw new Error("accessor or hidden property")
      }
      const serializedKey = JSON.stringify(key)
      if (serializedKey === undefined) throw new Error("unsupported key")
      serialized.push(`${serializedKey}:${caddyConfigSerializeValue(descriptor.value, active)}`)
    }
  } finally {
    active.delete(value)
  }
  return `{${serialized.join(",")}}`
}

export function caddyConfigSerialize(config: unknown): Result<string> {
  const op = "caddyConfigSerialize"
  try {
    return createResult(caddyConfigSerializeValue(config, new Set()))
  } catch {
    return createResultError(op, "Caddy configuration is not serializable")
  }
}
