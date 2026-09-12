import type { ProjectClassificationType } from "./projectClassificationType.js"

const projectClassificationSections: Record<ProjectClassificationType, string> = {
  customer: "Kunden",
  internal: "Interne",
  own: "Eigene",
}

export function projectClassificationNormalize(
  labels: Record<string, string>,
  type: ProjectClassificationType | undefined,
): Record<string, string> {
  if (labels.section !== undefined && labels.section.trim() !== "") return labels
  const section = type === undefined ? undefined : projectClassificationSections[type]
  if (section === undefined) return labels
  return { ...labels, section }
}
