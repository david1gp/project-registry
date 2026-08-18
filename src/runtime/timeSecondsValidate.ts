const maximumUnixSeconds = Math.floor(Number.MAX_SAFE_INTEGER / 1000)

export function timeSecondsValidate(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximumUnixSeconds
}
