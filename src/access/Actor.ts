import type { Role } from "./Role.js"

export type Actor = {
  subject: string | null
  username: string
  role: Role | undefined
}
