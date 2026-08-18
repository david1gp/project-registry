import { envMode } from "#ui/env/envMode.js"
import { getEnvMode } from "#ui/env/getEnvMode.js"

export function isProdEnv(fallback = envMode.missing): boolean {
  return getEnvMode(fallback) === envMode.production
}
