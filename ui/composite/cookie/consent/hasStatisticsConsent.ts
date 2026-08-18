import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import { getStoredConsent } from "./getStoredConsent.js"

export function hasStatisticsConsent(config: ConsentConfig = defaultConsentConfig): boolean {
  return getStoredConsent(config)?.statistics === true
}
