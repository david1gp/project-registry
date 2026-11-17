import { createResult, createResultError, type PromiseResult } from "#result"

/** Resolve both supplementary and primary members through the system NSS database. */
export async function projectRegistryGroupMembersResolve(group: string): PromiseResult<readonly string[]> {
  const op = "projectRegistryGroupMembersResolve"
  try {
    const groupProcess = Bun.spawn(["getent", "group", group], { stdout: "pipe", stderr: "ignore" })
    const groupText = await new Response(groupProcess.stdout).text()
    if ((await groupProcess.exited) !== 0) return createResultError(op, `group ${group} is unavailable`)
    const fields = groupText.trim().split(":")
    if (fields.length !== 4 || !/^\d+$/.test(fields[2]!)) return createResultError(op, "invalid group entry")
    const members = new Set(fields[3]!.split(",").filter(Boolean))
    const passwdProcess = Bun.spawn(["getent", "passwd"], { stdout: "pipe", stderr: "ignore" })
    const passwdText = await new Response(passwdProcess.stdout).text()
    if ((await passwdProcess.exited) !== 0) return createResultError(op, "user directory is unavailable")
    for (const line of passwdText.split("\n")) {
      const entry = line.split(":")
      if (entry.length >= 4 && entry[3] === fields[2] && entry[0]) members.add(entry[0])
    }
    return createResult([...members])
  } catch (error) {
    return createResultError(op, error instanceof Error ? error.message : "group lookup failed")
  }
}
