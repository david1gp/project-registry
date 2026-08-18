export type CaddyTimer = {
  wait(delayMs: number, signal?: AbortSignal): Promise<void>
  setInterval(callback: () => void, delayMs: number): unknown
  clearInterval(handle: unknown): void
  setTimeout?(callback: () => void, delayMs: number): unknown
  clearTimeout?(handle: unknown): void
}
