const unitSegmentPattern = /^[a-z0-9][a-z0-9-]*$/

/** `proj-<project>-<service>.service`; undefined for names unsafe in a unit name. */
export function managedServiceUnitName(project: string, service: string): string | undefined {
  if (!unitSegmentPattern.test(project) || !unitSegmentPattern.test(service)) return undefined
  return `proj-${project}-${service}.service`
}
