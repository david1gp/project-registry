/** Container engines a managed service may run under (`service.container`). */
export const projectServiceManagedContainers = ["podman"] as const

export type ProjectServiceManagedContainer = (typeof projectServiceManagedContainers)[number]
