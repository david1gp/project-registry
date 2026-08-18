import type { Project } from "./projectSchema.js"

const projectTypeOrder: Record<Project["type"], number> = {
  internal: 0,
  customer: 1,
  own: 2,
}

function stringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function projectSort(projects: readonly Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const typeOrder = projectTypeOrder[left.type] - projectTypeOrder[right.type]
    if (typeOrder !== 0) return typeOrder
    if (left.order !== right.order) return left.order - right.order
    const nameOrder = stringCompare(left.name, right.name)
    if (nameOrder !== 0) return nameOrder
    return stringCompare(left.owner, right.owner)
  })
}
