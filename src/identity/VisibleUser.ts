import type { Role } from "../access/Role.js"

export type VisibleUser = {
  subject: string
  username: string
  role: Role | undefined
}
