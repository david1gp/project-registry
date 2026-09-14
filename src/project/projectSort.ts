import type { Project } from "./Project.js"

const projectSectionOrder: Record<string, number> = {
  Interne: 0,
  Kunden: 1,
  Eigene: 2,
}
const projectSectionFallbackOrder = Object.keys(projectSectionOrder).length
const projectSectionLastOrder = projectSectionFallbackOrder + 1

function stringCompare(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

export function projectSort(projects: readonly Project[]): Project[] {
  return [...projects].sort((left, right) => {
    const leftSection = left.labels.section ?? ""
    const rightSection = right.labels.section ?? ""
    const leftSectionOrder =
      leftSection === "Intern"
        ? projectSectionLastOrder
        : (projectSectionOrder[leftSection] ?? projectSectionFallbackOrder)
    const rightSectionOrder =
      rightSection === "Intern"
        ? projectSectionLastOrder
        : (projectSectionOrder[rightSection] ?? projectSectionFallbackOrder)
    if (leftSectionOrder !== rightSectionOrder) return leftSectionOrder - rightSectionOrder
    const sectionOrder = stringCompare(leftSection, rightSection)
    if (sectionOrder !== 0) return sectionOrder
    if (left.order !== right.order) return left.order - right.order
    const nameOrder = stringCompare(left.name, right.name)
    if (nameOrder !== 0) return nameOrder
    return stringCompare(left.owner, right.owner)
  })
}
