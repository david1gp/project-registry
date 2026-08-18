import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import { getStoredConsent } from "./getStoredConsent.js"

export function hasAnyTrackingConsent(config: ConsentConfig = defaultConsentConfig): boolean {
  const stored = getStoredConsent(config)
  return stored?.statistics === true || stored?.marketing === true
}
