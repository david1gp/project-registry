import type { Role } from "../access/Role.js"

export type MappedUser = {
  subject: string
  username: string
  role: Role | undefined
}
