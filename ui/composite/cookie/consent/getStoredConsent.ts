import { buildPreferences } from "./buildPreferences.js"
import { type ConsentConfig, defaultConsentConfig } from "./consentConfig.js"
import type { ConsentPreferences } from "./consentTypes.js"

/** Read + normalize the persisted consent, or `null` when none is stored. */
export function getStoredConsent(config: ConsentConfig = defaultConsentConfig): ConsentPreferences | null {
  if (typeof window === "undefined") return null

  try {
    const raw = window.localStorage.getItem(config.storageKey)
    if (!raw) return null

    const parsed = JSON.parse(raw) as Partial<ConsentPreferences> | null
    if (!parsed || typeof parsed !== "object") return null

    return buildPreferences({
      statistics: parsed.statistics === true,
      marketing: parsed.marketing === true,
    })
  } catch {
    return null
  }
}
