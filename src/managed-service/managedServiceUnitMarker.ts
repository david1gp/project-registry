/**
 * First line of every unit the registry writes. Reconcile only ever stops,
 * disables, or deletes `proj-*.service` files that start with this line, so
 * hand-written units with a colliding name are never touched.
 */
export const managedServiceUnitMarker = "# managed-by: project-registry"
