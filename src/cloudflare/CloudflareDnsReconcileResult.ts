import type { CloudflareDnsRecord } from "./CloudflareDnsRecord.js"

export type CloudflareDnsReconcileResult = {
  action: "created" | "updated" | "skipped"
  zone: {
    id: string
    name: string
  }
  record: CloudflareDnsRecord
}
