import { type EnvMode, envMode } from "./envMode.js"

export function getEnvMode(fallback: EnvMode = envMode.production): EnvMode {
  // Overwrite Convex env mode
  if (typeof process !== "undefined" && process.env?.ENV_MODE) {
    return process.env.ENV_MODE as EnvMode
  }
  // Check Node.js process environment first
  if (typeof process !== "undefined" && process.env?.NODE_ENV) {
    return process.env.NODE_ENV as EnvMode
  }
  // Check Vite-style import.meta.env
  if (typeof import.meta !== "undefined" && import.meta.env?.MODE) {
    return import.meta.env.MODE as EnvMode
  }
  // Fallback to production for safety
  return fallback
}
