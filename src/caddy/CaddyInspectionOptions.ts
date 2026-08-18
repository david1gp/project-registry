import type { Actor } from "../access/Actor.js"
import type { CaddyProjectListAccess } from "./CaddyProjectListAccess.js"

export type CaddyInspectionOptions = {
  actor: Actor
  projectList?: CaddyProjectListAccess
  access?: {
    projectList?: CaddyProjectListAccess
  }
}
