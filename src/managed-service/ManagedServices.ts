import type { PromiseResult, Result } from "#result"
import type { Actor } from "../access/Actor.js"
import type { ManagedServiceAction } from "./ManagedServiceAction.js"
import type { ManagedServiceStatus } from "./ManagedServiceStatus.js"
import type { ManagedServiceReconcileSummary } from "./managedServiceReconcile.js"

export type ManagedServiceTarget = { project: string; service?: string }

export type ManagedServices = {
  enabled: boolean
  /** Serialized and coalesced: concurrent requests share one follow-up pass. */
  reconcile(startup?: boolean): PromiseResult<ManagedServiceReconcileSummary>
  status(actor: Actor, target: ManagedServiceTarget): PromiseResult<ManagedServiceStatus[]>
  act(actor: Actor, action: ManagedServiceAction, target: ManagedServiceTarget): PromiseResult<ManagedServiceStatus>
  logs(
    actor: Actor,
    target: ManagedServiceTarget,
    lines: number,
    follow: boolean,
  ): PromiseResult<{ stream: ReadableStream<Uint8Array>; cancel: () => void }>
  lastReconcile(): Result<ManagedServiceReconcileSummary> | undefined
}
