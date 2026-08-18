import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import type { GoogleTrackingConfig } from "./consentTypes.js"
import { getStoredConsent } from "./getStoredConsent.js"
import { loadGoogleTag } from "./loadGoogleTag.js"
import { updateConsentMode } from "./updateConsentMode.js"

/**
 * Load gtag.js and configure GA4 / Google Ads, respecting the stored consent.
 * Safe to call on every page load — it no-ops when no tracking consent is given.
 */
export function enableGoogleTracking(
  trackingConfig: GoogleTrackingConfig,
  config: ConsentConfig = defaultConsentConfig,
): boolean {
  if (typeof window === "undefined") return false

  const stored = getStoredConsent(config)
  if (!stored || (!stored.statistics && !stored.marketing)) return false

  updateConsentMode(stored)

  const gaId = trackingConfig.gaId?.trim()
  const adsId = trackingConfig.adsId?.trim()
  const primaryId = (stored.statistics && gaId) || (stored.marketing && adsId) || gaId || adsId
  if (!primaryId) return false

  loadGoogleTag(primaryId)

  if (stored.statistics && gaId) window.gtag?.("config", gaId)
  if (stored.marketing && adsId) window.gtag?.("config", adsId)

  return true
}
