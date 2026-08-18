import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import { ensureGtag } from "./ensureGtag.js"
import { hasAnyTrackingConsent } from "./hasAnyTrackingConsent.js"

export function trackEvent(
  name: string,
  params: Record<string, unknown> = {},
  config: ConsentConfig = defaultConsentConfig,
): boolean {
  if (typeof window === "undefined" || !hasAnyTrackingConsent(config)) return false

  ensureGtag()
  window.gtag?.("event", name, params)
  return true
}
