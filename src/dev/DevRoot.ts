/**
 * One dev root: every direct child directory of `path` is `dev up`-able by
 * the listed users. `users` undefined means every caller (legacy single
 * `PROJECT_REGISTRY_DEV_PROJECTS_ROOT` fallback).
 */
export type DevRoot = {
  path: string
  users?: readonly string[]
}
