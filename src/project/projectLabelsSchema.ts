import * as a from "valibot"

function projectLabelsRecord(input: unknown): input is Record<string, string> {
  if (input === null || typeof input !== "object" || Array.isArray(input)) return false

  try {
    return Object.keys(input).every((key) => {
      if (key.trim() === "") return false
      const descriptor = Object.getOwnPropertyDescriptor(input, key)
      return descriptor !== undefined && "value" in descriptor && typeof descriptor.value === "string"
    })
  } catch {
    return false
  }
}

function projectLabelsCopy(input: Record<string, string>): Record<string, string> {
  const output: Record<string, string> = {}

  for (const key of Object.keys(input)) {
    Object.defineProperty(output, key, {
      configurable: true,
      enumerable: true,
      value: input[key],
      writable: true,
    })
  }

  return output
}

export const projectLabelsSchema = a.pipe(
  a.custom<Record<string, string>>(
    projectLabelsRecord,
    "labels must be an object of string values with non-blank keys",
  ),
  a.transform(projectLabelsCopy),
)
