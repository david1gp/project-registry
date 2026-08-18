/**
 * Shared types for the cookie-consent + Google tracking helpers.
 *
 * - Consent is persisted in `localStorage` (no third-party cookie library).
 * - Google Consent Mode v2 defaults everything to "denied" until the user opts in.
 * - `gtag.js` is only injected once the user grants statistics and/or marketing.
 */

export type ConsentCategory = "statistics" | "marketing"

export type ConsentChoices = Record<ConsentCategory, boolean>

export type ConsentPreferences = ConsentChoices & {
  necessary: true
  updatedAt: string
}

export type GoogleTrackingConfig = {
  /** GA4 measurement id, e.g. `G-XXXXXXXXXX`. */
  gaId?: string
  /** Google Ads id, e.g. `AW-XXXXXXXXXX`. */
  adsId?: string
}

export type ConsentModeValue = "granted" | "denied"

export type ConsentModeState = {
  ad_storage: ConsentModeValue
  analytics_storage: ConsentModeValue
  ad_user_data: ConsentModeValue
  ad_personalization: ConsentModeValue
}

export type GtagFunction = (...args: unknown[]) => void

declare global {
  interface Window {
    dataLayer?: unknown[]
    gtag?: GtagFunction
  }
}
