import { mdiCheckboxBlankCircleOutline, mdiCheckboxMarkedCircle } from "@mdi/js"
import { ButtonIcon } from "#ui/interactive/button/ButtonIcon.jsx"
import { buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"
import type { MayHaveButtonVariant } from "#ui/utils/MayHaveButtonVariant.js"
import type { MayHaveClass } from "#ui/utils/MayHaveClass.js"
import type { MayHaveDisabled } from "#ui/utils/MayHaveDisabled.js"
import type { MayHaveId } from "#ui/utils/MayHaveId.js"
import type { MayHaveInnerClass } from "#ui/utils/MayHaveInnerClass.js"

export interface CheckBooleanProps
  extends MayHaveId,
    MayHaveButtonVariant,
    MayHaveClass,
    MayHaveInnerClass,
    MayHaveDisabled {
  valueSignal: SignalObject<boolean>
  valueText: (value: boolean) => string
  optionClass?: string
}

/** Two-button boolean selector showing both options side by side. */
export function CheckBoolean(p: CheckBooleanProps) {
  const currentValue = () => p.valueSignal.get()

  return (
    <div
      id={p.id}
      class={classMerge(
        "group border border-input",
        "px-2 py-2",
        "ring-offset-background",
        "rounded-md",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        "flex flex-col justify-center gap-1", // layout
        p.class,
      )}
    >
      <div class="flex gap-2">
        <ButtonIcon
          role="option"
          aria-selected={!currentValue()}
          icon={!currentValue() ? mdiCheckboxMarkedCircle : mdiCheckboxBlankCircleOutline}
          onClick={() => p.valueSignal.set(false)}
          variant={!currentValue() ? (p.variant ?? buttonVariant.filled) : buttonVariant.outline}
          class={classMerge("justify-start text-left", p.innerClass, p.optionClass)}
          disabled={p.disabled}
        >
          {p.valueText(false)}
        </ButtonIcon>

        <ButtonIcon
          role="option"
          aria-selected={currentValue()}
          icon={currentValue() ? mdiCheckboxMarkedCircle : mdiCheckboxBlankCircleOutline}
          onClick={() => p.valueSignal.set(true)}
          variant={currentValue() ? (p.variant ?? buttonVariant.filled) : buttonVariant.outline}
          class={classMerge("justify-start text-left", p.innerClass, p.optionClass)}
          disabled={p.disabled}
        >
          {p.valueText(true)}
        </ButtonIcon>
      </div>
    </div>
  )
}
