/**
 * Configurable storage key + event names + schema version for the consent helpers.
 *
 * Every helper accepts a `ConsentConfig` (defaulting to {@link defaultConsentConfig}),
 * so multiple banners / apps can coexist without clashing on `localStorage` keys or
 * `window` events. Override via {@link resolveConsentConfig} or the banner's `consentConfig` prop.
 */
export type ConsentConfig = {
  /** `localStorage` key the consent preferences are persisted under. */
  storageKey: string
  /** Event the banner listens for to (re-)open its settings view. */
  preferencesEvent: string
  /** Event dispatched on `window` whenever consent is saved. */
  changeEvent: string
}

export const defaultConsentConfig: ConsentConfig = {
  storageKey: "cookie_consent",
  preferencesEvent: "solid-ui:cookie-preferences",
  changeEvent: "solid-ui:cookie-consent-change",
}

/** Merge a partial override over the defaults. */
export function resolveConsentConfig(config?: Partial<ConsentConfig>): ConsentConfig {
  return { ...defaultConsentConfig, ...config }
}
