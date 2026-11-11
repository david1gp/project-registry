import type { PromiseResult } from "#result"

// Spawn seam for dev servers (Track D, increment D2): the daemon runs
// `systemd-run` as root to start a transient SYSTEM unit with
// User=<socket-user> and Slice=user-<uid>.slice, so the unit lands in the
// requesting user's slice without ever running as root. The production
// implementation lands with D2; the default below errors until then.
export type DevProcessRunner = (
  command: string,
  args: readonly string[],
  input: string,
) => PromiseResult<{
  exitCode: number
  stdout: string
  stderr: string
}>
