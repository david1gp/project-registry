export const managedServiceLogsDefaultLines = 100
export const managedServiceLogsMaximumLines = 10_000

/** journalctl argv for one unit: bounded `-n`, short-iso output, optional follow. */
export function managedServiceLogsArgs(unit: string, lines: number, follow: boolean): string[] {
  const bounded = Math.min(Math.max(1, Math.trunc(lines)), managedServiceLogsMaximumLines)
  return [
    "--unit",
    unit,
    "--lines",
    String(bounded),
    "--no-pager",
    "--output",
    "short-iso",
    ...(follow ? ["--follow"] : []),
  ]
}
