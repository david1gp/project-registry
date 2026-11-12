import { createResult, type PromiseResult } from "#result"
import type { DevProcessRunner } from "../dev/DevProcessRunner.js"
import type { ManagedServiceEntry } from "./ManagedServiceEntry.js"
import type { ManagedServiceStatus } from "./ManagedServiceStatus.js"
import { managedServiceSystemctl } from "./managedServiceSystemctl.js"

function propertiesParse(stdout: string): Map<string, string> {
  const properties = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const separator = line.indexOf("=")
    if (separator > 0) properties.set(line.slice(0, separator), line.slice(separator + 1))
  }
  return properties
}

/** `systemctl show` per unit; an unknown unit reads as inactive/not-found rather than failing the list. */
export async function managedServiceStatusRead(
  runner: DevProcessRunner,
  entries: readonly ManagedServiceEntry[],
): PromiseResult<ManagedServiceStatus[]> {
  const statuses: ManagedServiceStatus[] = []
  for (const entry of entries) {
    const showR = await managedServiceSystemctl(
      runner,
      ["show", entry.unit, "--property=ActiveState,SubState,UnitFileState,MainPID"],
      true,
    )
    if (!showR.success) return showR
    const properties = propertiesParse(showR.data.stdout)
    const mainPid = Number(properties.get("MainPID") ?? "0")
    statuses.push({
      owner: entry.owner,
      project: entry.project,
      service: entry.serviceId,
      unit: entry.unit,
      port: entry.port,
      domains: [...entry.domains],
      autostart: entry.managed.autostart,
      activeState: properties.get("ActiveState") || "unknown",
      subState: properties.get("SubState") || "unknown",
      unitFileState: properties.get("UnitFileState") || "not-found",
      mainPid: Number.isSafeInteger(mainPid) ? mainPid : 0,
    })
  }
  return createResult(statuses)
}
