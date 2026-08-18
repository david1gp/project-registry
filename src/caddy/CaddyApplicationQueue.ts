export type CaddyApplicationQueue = {
  enqueue<T>(work: () => Promise<T>): Promise<T>
}
