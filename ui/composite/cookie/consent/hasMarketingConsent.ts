import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import { getStoredConsent } from "./getStoredConsent.js"

export function hasMarketingConsent(config: ConsentConfig = defaultConsentConfig): boolean {
  return getStoredConsent(config)?.marketing === true
}
