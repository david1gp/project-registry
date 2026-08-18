import { createResult, createResultError, type Result } from "#result"
import type { MappedUser } from "../identity/MappedUser.js"
import type { VisibleUser } from "../identity/VisibleUser.js"
import type { Actor } from "./Actor.js"
import type { Role } from "./Role.js"

function roleIsKnown(role: unknown): role is Role {
  return role === "own" || role === "admin" || role === "superadmin"
}

function actorIsValid(actor: Actor): boolean {
  if (typeof actor !== "object" || actor === null) return false
  return (
    typeof actor.username === "string" &&
    actor.username.length > 0 &&
    actor.username.length <= 256 &&
    (actor.subject === null ||
      (typeof actor.subject === "string" && actor.subject.length > 0 && actor.subject.length <= 256)) &&
    roleIsKnown(actor.role)
  )
}

function userIsValid(user: MappedUser): boolean {
  if (typeof user !== "object" || user === null) return false
  return (
    typeof user.subject === "string" &&
    user.subject.length > 0 &&
    user.subject.length <= 256 &&
    typeof user.username === "string" &&
    user.username.length > 0 &&
    user.username.length <= 256 &&
    roleIsKnown(user.role)
  )
}

function usersAreUnique(users: readonly MappedUser[]): boolean {
  const subjects = new Set<string>()
  const usernames = new Set<string>()
  for (const user of users) {
    if (!userIsValid(user)) return false
    if (subjects.has(user.subject) || usernames.has(user.username)) return false
    subjects.add(user.subject)
    usernames.add(user.username)
  }
  return true
}

export function visibleUserList(actor: Actor, users: readonly MappedUser[]): Result<VisibleUser[]> {
  const op = "visibleUserList"
  if (!actorIsValid(actor)) return createResultError(op, "actor mapping or current role is unavailable")
  if (!Array.isArray(users) || users.length > 10_000 || !usersAreUnique(users)) {
    return createResultError(op, "mapped user directory contains an invalid mapping")
  }

  if (actor.role === "own") return createResult([])

  const visibleUsers = users.filter(
    (user) => actor.role === "superadmin" || user.role === "own" || user.role === "admin",
  )
  return createResult(visibleUsers)
}
