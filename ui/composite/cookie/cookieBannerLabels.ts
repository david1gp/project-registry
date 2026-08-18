import type { ConsentCategory } from "./consent/consentTypes.js"

/** Texts describing a single consent category card. */
export type CookieCategoryLabels = {
  title: string
  description: string
  tools: string
}

/** An opt-in category, tying its texts to the consent key it toggles. */
export type OptionalCategory = CookieCategoryLabels & { id: ConsentCategory }

/** Every user-facing string in the banner — override individually via the `labels` prop. */
export type CookieBannerLabels = {
  /** Heading shown on the initial (non-settings) view. */
  defaultTitle: string
  /** Heading shown on the settings view. */
  settingsTitle: string
  /** Body copy shown on the initial view. */
  defaultDescription: string
  /** Body copy shown on the settings view. */
  settingsDescription: string
  /** The always-on "necessary" category card. */
  necessary: CookieCategoryLabels
  /** The opt-in categories rendered in the settings view. */
  optionalCategories: OptionalCategory[]
  /** "Services:" prefix inside each category card. */
  servicesLabel: string
  /** Appended to a category's aria-label when it is enabled. */
  enabledSuffix: string
  /** Appended to a category's aria-label when it is disabled. */
  disabledSuffix: string
  /** Reject-all button. */
  rejectAll: string
  /** Open-settings button (initial view). */
  customize: string
  /** Save-selection button (settings view). */
  saveSelection: string
  /** Accept-all button. */
  acceptAll: string
  /** Privacy-policy link text. */
  privacyLabel: string
  /** Imprint link text. */
  imprintLabel: string
  /** Reassurance note in the footer. */
  footerNote: string
  /** Default label for the standalone `CookieSettingsButton`. */
  settingsButton: string
}

export const defaultCookieBannerLabels: CookieBannerLabels = {
  defaultTitle: "Website optimal nutzen?",
  settingsTitle: "Cookie-Einstellungen",
  defaultDescription:
    "Mit Ihrer Zustimmung können wir die Nutzung analysieren und unsere Angebote relevanter machen. Notwendige Technologien bleiben immer aktiv.",
  settingsDescription:
    "Wählen Sie aus, welche optionalen Dienste wir nutzen dürfen. Sie können Ihre Entscheidung jederzeit ändern.",
  necessary: {
    title: "Notwendige Technologien",
    description: "Erforderlich für Sicherheit, Seitenauslieferung und das Speichern Ihrer Auswahl.",
    tools: "Consent-Speicherung, Session-Funktionen",
  },
  optionalCategories: [
    {
      id: "statistics",
      title: "Statistik",
      description: "Hilft uns zu verstehen, wie die Website genutzt wird, um Inhalte und Technik zu verbessern.",
      tools: "Google Analytics 4",
    },
    {
      id: "marketing",
      title: "Marketing",
      description: "Misst Kampagnen und spielt Angebote relevanter aus.",
      tools: "Google Ads, Remarketing",
    },
  ],
  servicesLabel: "Dienste:",
  enabledSuffix: "aktiviert",
  disabledSuffix: "deaktiviert",
  rejectAll: "Nur notwendige",
  customize: "Auswahl anpassen",
  saveSelection: "Auswahl speichern",
  acceptAll: "Alle akzeptieren",
  privacyLabel: "Datenschutzerklärung",
  imprintLabel: "Impressum",
  footerNote: "Keine optionalen Dienste ohne Zustimmung.",
  settingsButton: "Cookie-Einstellungen",
}
