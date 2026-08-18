import { classArr } from "#ui/utils/classArr.js"

export interface ConsentSwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onClick?: () => void
}

/** Accessible toggle switch for consent choices. */
export function ConsentSwitch(p: ConsentSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={p.checked}
      aria-label={p.label}
      disabled={p.disabled}
      onClick={p.onClick}
      class={classArr(
        "relative inline-flex h-7 w-12 shrink-0 items-center rounded-full transition-colors",
        "focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-green-500 focus-visible:ring-offset-2",
        p.checked ? "bg-green-600" : "bg-slate-300 dark:bg-slate-600",
        p.disabled ? "cursor-not-allowed opacity-70" : "cursor-pointer",
      )}
    >
      <span
        class={classArr(
          "inline-block size-5 rounded-full bg-white shadow transition-transform",
          p.checked ? "translate-x-6" : "translate-x-1",
        )}
      />
    </button>
  )
}
