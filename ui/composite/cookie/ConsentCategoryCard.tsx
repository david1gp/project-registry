import { ConsentSwitch } from "./ConsentSwitch.jsx"

export interface ConsentCategoryCardProps {
  title: string
  description: string
  tools: string
  /** Prefix shown before the list of tools (e.g. "Dienste:"). */
  servicesLabel: string
  /** aria-label suffix for the toggle when the category is enabled. */
  enabledSuffix: string
  /** aria-label suffix for the toggle when the category is disabled. */
  disabledSuffix: string
  checked: boolean
  disabled?: boolean
  onToggle?: () => void
}

/** Cookie consent category card with toggle switch. */
export function ConsentCategoryCard(p: ConsentCategoryCardProps) {
  return (
    <section class="rounded-xl border border-slate-200 bg-slate-50 p-4 dark:border-slate-700 dark:bg-slate-800/50">
      <div class="flex items-start justify-between gap-4">
        <div>
          <h3 class="font-semibold">{p.title}</h3>
          <p class="mt-1 text-sm leading-relaxed text-slate-600 dark:text-slate-400">{p.description}</p>
          <p class="mt-2 text-sm text-slate-500 dark:text-slate-500">
            <span class="font-medium text-slate-700 dark:text-slate-300">{p.servicesLabel}</span> {p.tools}
          </p>
        </div>
        <ConsentSwitch
          checked={p.checked}
          disabled={p.disabled}
          label={`${p.title} ${p.checked ? p.enabledSuffix : p.disabledSuffix}`}
          onClick={p.onToggle}
        />
      </div>
    </section>
  )
}
