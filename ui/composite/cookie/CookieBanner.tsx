import Dialog from "@corvu/dialog"
import { mdiCookie, mdiShieldCheckOutline } from "@mdi/js"
import { createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { Button } from "#ui/interactive/button/Button.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { classesDialogOverlayMerge } from "#ui/interactive/dialog/classesDialogContent.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { ConsentCategoryCard } from "./ConsentCategoryCard.jsx"
import { ConsentFooterLinks } from "./ConsentFooterLinks.jsx"
import { acceptAllConsent } from "./consent/acceptAllConsent.js"
import { type ConsentConfig, resolveConsentConfig } from "./consent/consentConfig.js"
import type {
  ConsentCategory,
  ConsentChoices,
  ConsentPreferences,
  GoogleTrackingConfig,
} from "./consent/consentTypes.js"
import { enableGoogleTracking } from "./consent/enableGoogleTracking.js"
import { getStoredConsent } from "./consent/getStoredConsent.js"
import { initConsentMode } from "./consent/initConsentMode.js"
import { rejectAllConsent } from "./consent/rejectAllConsent.js"
import { saveConsent } from "./consent/saveConsent.js"
import { type CookieBannerLabels, defaultCookieBannerLabels } from "./cookieBannerLabels.js"

export interface CookieBannerProps {
  /** GA4 measurement id, e.g. `G-XXXXXXXXXX`. */
  gaId?: string
  /** Google Ads id, e.g. `AW-XXXXXXXXXX`. */
  adsId?: string
  /** Link to the privacy policy. Defaults to `/datenschutz`. */
  privacyHref?: string
  /** Link to the imprint. Hidden when omitted. */
  imprintHref?: string
  /** Override any of the banner texts / categories. Merged over the German defaults. */
  labels?: Partial<CookieBannerLabels>
  /** Override the `localStorage` key + event names. */
  consentConfig?: Partial<ConsentConfig>
  /** Controlled visibility. When provided, the banner reflects this instead of its internal signal. */
  open?: boolean
  /** Notified whenever the banner wants to open/close. */
  onOpenChange?: (open: boolean) => void
  /** Controlled settings view. When provided, overrides the internal signal. */
  showSettings?: boolean
  /** Notified whenever the settings view is toggled. */
  onShowSettingsChange?: (showSettings: boolean) => void
  /** Called whenever consent is persisted (accept / reject / save). */
  onConsentChange?: (preferences: ConsentPreferences) => void
}

/** Cookie consent banner gating Google tracking. */
export function CookieBanner(p: CookieBannerProps) {
  const [internalVisible, setInternalVisible] = createSignal(false)
  const [internalShowSettings, setInternalShowSettings] = createSignal(false)
  const [choices, setChoices] = createSignal<ConsentChoices>({
    statistics: false,
    marketing: false,
  })

  const labels = (): CookieBannerLabels => ({
    ...defaultCookieBannerLabels,
    ...p.labels,
  })
  const config = (): ConsentConfig => resolveConsentConfig(p.consentConfig)
  const trackingConfig = (): GoogleTrackingConfig => ({
    gaId: p.gaId,
    adsId: p.adsId,
  })

  const isVisible = () => (p.open !== undefined ? p.open : internalVisible())
  const setVisible = (v: boolean) => {
    if (p.open === undefined) setInternalVisible(v)
    p.onOpenChange?.(v)
  }

  const showSettings = () => (p.showSettings !== undefined ? p.showSettings : internalShowSettings())
  const setShowSettings = (v: boolean) => {
    if (p.showSettings === undefined) setInternalShowSettings(v)
    p.onShowSettingsChange?.(v)
  }

  onMount(() => {
    initConsentMode()

    const stored = getStoredConsent(config())
    if (stored) {
      setChoices({
        statistics: stored.statistics,
        marketing: stored.marketing,
      })
      // Returning visitor with prior consent — re-arm Google tracking on this page load.
      enableGoogleTracking(trackingConfig(), config())
    } else {
      setVisible(true)
    }

    const openPreferences = () => {
      const current = getStoredConsent(config())
      if (current)
        setChoices({
          statistics: current.statistics,
          marketing: current.marketing,
        })
      setShowSettings(true)
      setVisible(true)
    }

    const event = config().preferencesEvent
    window.addEventListener(event, openPreferences)
    onCleanup(() => window.removeEventListener(event, openPreferences))
  })

  const close = () => {
    setVisible(false)
    setShowSettings(false)
  }

  const applyAndClose = (choice: ConsentChoices) => {
    const preferences = saveConsent(choice, config())
    enableGoogleTracking(trackingConfig(), config())
    p.onConsentChange?.(preferences)
    close()
  }

  const handleAcceptAll = () => {
    const preferences = acceptAllConsent(config())
    enableGoogleTracking(trackingConfig(), config())
    p.onConsentChange?.(preferences)
    close()
  }

  const handleRejectAll = () => {
    const preferences = rejectAllConsent(config())
    p.onConsentChange?.(preferences)
    close()
  }

  const handleSaveSelection = () => applyAndClose(choices())

  const toggle = (id: ConsentCategory) => setChoices((c) => ({ ...c, [id]: !c[id] }))

  return (
    // Consent gate: non-dismissable (no Esc / outside-click / close button) so a choice must be made.
    // The corvu Dialog primitive gives focus-trap, scroll-lock and aria wiring for free.
    <Dialog
      open={isVisible()}
      onOpenChange={setVisible}
      role="alertdialog"
      closeOnEscapeKeyDown={false}
      closeOnOutsidePointer={false}
      closeOnOutsideFocus={false}
    >
      <Dialog.Portal>
        <Dialog.Overlay class={classesDialogOverlayMerge("z-80 bg-black/30 backdrop-blur-xs")} />
        <Dialog.Content class="fixed inset-0 z-80 flex items-end justify-center p-3 focus:outline-none sm:p-6">
          <div class="w-full max-w-2xl overflow-hidden rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100">
            <div class="max-h-[calc(100svh-1.5rem)] overflow-y-auto">
              <div class="p-5 sm:p-6">
                <div class="flex items-start justify-between gap-3">
                  <div>
                    <Dialog.Label class="text-xl font-semibold tracking-tight sm:text-2xl">
                      <Show when={showSettings()} fallback={labels().defaultTitle}>
                        {labels().settingsTitle}
                      </Show>
                    </Dialog.Label>
                    <Dialog.Description class="mt-2 text-sm leading-relaxed text-slate-600 sm:text-base dark:text-slate-400">
                      <Show when={showSettings()} fallback={labels().defaultDescription}>
                        {labels().settingsDescription}
                      </Show>
                    </Dialog.Description>
                  </div>
                  <span class="mt-0.5 flex shrink-0 items-center justify-center text-green-700 dark:text-green-300">
                    <Icon path={showSettings() ? mdiCookie : mdiShieldCheckOutline} class="size-10 dark:fill-current" />
                  </span>
                </div>

                <Show when={showSettings()}>
                  <div class="mt-5 space-y-3">
                    <ConsentCategoryCard
                      title={labels().necessary.title}
                      description={labels().necessary.description}
                      tools={labels().necessary.tools}
                      servicesLabel={labels().servicesLabel}
                      enabledSuffix={labels().enabledSuffix}
                      disabledSuffix={labels().disabledSuffix}
                      checked
                      disabled
                    />
                    <For each={labels().optionalCategories}>
                      {(category) => (
                        <ConsentCategoryCard
                          title={category.title}
                          description={category.description}
                          tools={category.tools}
                          servicesLabel={labels().servicesLabel}
                          enabledSuffix={labels().enabledSuffix}
                          disabledSuffix={labels().disabledSuffix}
                          checked={choices()[category.id]}
                          onToggle={() => toggle(category.id)}
                        />
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              <div class="sticky bottom-0 border-t border-slate-200 bg-white/95 p-4 backdrop-blur sm:p-5 dark:border-slate-700 dark:bg-slate-900/95">
                <div class="grid gap-2 sm:grid-cols-3">
                  <Button
                    variant={buttonVariant.outline}
                    class="order-3 rounded-full sm:order-1"
                    onClick={handleRejectAll}
                  >
                    {labels().rejectAll}
                  </Button>
                  <Show
                    when={showSettings()}
                    fallback={
                      <Button
                        variant={buttonVariant.outline}
                        class="order-2 rounded-full"
                        onClick={() => setShowSettings(true)}
                      >
                        {labels().customize}
                      </Button>
                    }
                  >
                    <Button
                      variant={buttonVariant.filledGreen}
                      class="order-1 rounded-full sm:order-2"
                      onClick={handleSaveSelection}
                    >
                      {labels().saveSelection}
                    </Button>
                  </Show>
                  <Button
                    variant={showSettings() ? buttonVariant.outline : buttonVariant.filledGreen}
                    class="order-1 rounded-full sm:order-3"
                    onClick={handleAcceptAll}
                  >
                    {labels().acceptAll}
                  </Button>
                </div>
                <ConsentFooterLinks
                  privacyHref={p.privacyHref ?? "/datenschutz"}
                  privacyLabel={labels().privacyLabel}
                  imprintHref={p.imprintHref}
                  imprintLabel={labels().imprintLabel}
                  note={labels().footerNote}
                />
              </div>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog>
  )
}
