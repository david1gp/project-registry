import type { ProjectKey } from "./projectKey.js"

export function projectKeyEqual(left: ProjectKey, right: ProjectKey): boolean {
  return left.owner === right.owner && left.name === right.name
}
