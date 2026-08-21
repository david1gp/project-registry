export function projectAccessLogTimestampFormat(timestamp: number): string {
  return new Date(timestamp * 1_000).toLocaleString("de-DE")
}
