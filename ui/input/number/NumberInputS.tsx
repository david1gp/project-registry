import { mdiMinus } from "@adaptive-ds/mdi/mdiMinus.js"
import { mdiMinusBox } from "@adaptive-ds/mdi/mdiMinusBox.js"
import { mdiPlus } from "@adaptive-ds/mdi/mdiPlus.js"
import { mdiPlusBox } from "@adaptive-ds/mdi/mdiPlusBox.js"
import { type ComponentProps, type JSX, splitProps } from "solid-js"
import { Input } from "#ui/input/input/Input.jsx"
import type { NumberInputText } from "#ui/input/number/NumberInputTexts.jsx"
import { numberInputTextDefault } from "#ui/input/number/NumberInputTexts.jsx"
import { ButtonIconOnly } from "#ui/interactive/button/ButtonIconOnly.jsx"
import { type ButtonVariant, buttonVariant } from "#ui/interactive/button/buttonCva.js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { SignalObject } from "#ui/utils/createSignalObject.js"
import { safeParseInt } from "#utils/int/safeParseInt.js"

export interface NumberInputSProps extends ComponentProps<"input"> {
  valueSignal: SignalObject<number>
  min?: number
  max?: number
  incrDecrAmount?: number
  incrDecrAmountMajor?: number
  disabled?: boolean
  class?: string
  inputClass?: string
  variant?: ButtonVariant
  buttonClass?: string
  onValueChange?: (v: number) => void
  id?: string
  texts?: NumberInputText
}

/** Number input with increment and decrement buttons, signal-bound. */
export function NumberInputS(p: NumberInputSProps) {
  const [s, rest] = splitProps(p, [
    "valueSignal",
    "onValueChange",
    "min",
    "max",
    "incrDecrAmount",
    "incrDecrAmountMajor",
    "disabled",
    "class",
    "inputClass",
    "variant",
    "buttonClass",
    "id",
    "texts",
  ])
  const hasMajor = s.incrDecrAmountMajor !== undefined
  const onChange: JSX.InputEventHandlerUnion<HTMLInputElement, InputEvent> | undefined = (e) => {
    const n = s.valueSignal.get()
    let newN = safeParseInt(e.target.value, n)
    if (s.min !== undefined) newN = Math.max(s.min, newN)
    if (s.max !== undefined) newN = Math.min(s.max, newN)
    s.valueSignal.set(newN)
    if (s.onValueChange) s.onValueChange(newN)
  }
  const decrementMajor: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined = (e) => {
    const n = s.valueSignal.get()
    let newN = n - (s.incrDecrAmountMajor ?? 10) * (e.ctrlKey ? 100 : 1)
    if (s.min !== undefined) newN = Math.max(s.min, newN)
    s.valueSignal.set(newN)
    if (s.onValueChange) s.onValueChange(newN)
  }
  const decrement: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined = (e) => {
    const n = s.valueSignal.get()
    let newN = n - (s.incrDecrAmount ?? 1) * (e.ctrlKey ? 100 : 1)
    if (s.min !== undefined) newN = Math.max(s.min, newN)
    s.valueSignal.set(newN)
    if (s.onValueChange) s.onValueChange(newN)
  }
  const increment: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined = (e) => {
    const n = s.valueSignal.get()
    let newN = n + (s.incrDecrAmount ?? 1) * (e.ctrlKey ? 100 : 1)
    if (s.max !== undefined) newN = Math.min(s.max, newN)
    s.valueSignal.set(newN)
    if (s.onValueChange) s.onValueChange(newN)
  }
  const incrementMajor: JSX.EventHandlerUnion<HTMLButtonElement, MouseEvent> | undefined = (e) => {
    const n = s.valueSignal.get()
    let newN = n + (s.incrDecrAmountMajor ?? 10) * (e.ctrlKey ? 100 : 1)
    if (s.max !== undefined) newN = Math.min(s.max, newN)
    s.valueSignal.set(newN)
    if (s.onValueChange) s.onValueChange(newN)
  }
  const defaultVariant = buttonVariant.ghost

  const texts = s.texts ?? numberInputTextDefault

  return (
    <div class={classMerge("flex flex-row flex-nowrap items-center", s.class)}>
      {s.incrDecrAmountMajor && (
        <ButtonIconOnly
          icon={mdiMinusBox}
          title={texts.decreaseByX(s.incrDecrAmountMajor)}
          onClick={decrementMajor}
          variant={s.variant ?? defaultVariant}
          class={classMerge("rounded-r-none", s.buttonClass)}
          disabled={s.disabled || (s.min !== undefined && s.valueSignal.get() <= s.min)}
          type={"button"}
        />
      )}
      <ButtonIconOnly
        icon={mdiMinus}
        title={texts.decreaseByX(s.incrDecrAmount ?? 1)}
        onClick={decrement}
        variant={s.variant ?? defaultVariant}
        class={classMerge(hasMajor ? "rounded-none" : "rounded-r-none", s.buttonClass)}
        disabled={s.disabled || (s.min !== undefined && s.valueSignal.get() <= s.min)}
        type={"button"}
      />
      <Input
        type="number"
        value={s.valueSignal.get()}
        onInput={onChange}
        id={s.id}
        class={classMerge("w-14 rounded-none text-center outline-0 focus:z-10", s.inputClass)}
        disabled={s.disabled}
        min={s.min}
        max={s.max}
        {...rest}
      />
      <ButtonIconOnly
        icon={mdiPlus}
        title={texts.increaseByX(s.incrDecrAmount ?? 1)}
        onClick={increment}
        variant={s.variant ?? defaultVariant}
        class={classMerge(hasMajor ? "rounded-none" : "rounded-l-none", s.buttonClass)}
        disabled={s.disabled || (s.max !== undefined && s.valueSignal.get() >= s.max)}
        type={"button"}
      />
      {s.incrDecrAmountMajor && (
        <ButtonIconOnly
          icon={mdiPlusBox}
          title={texts.increaseByX(s.incrDecrAmountMajor)}
          onClick={incrementMajor}
          variant={s.variant ?? defaultVariant}
          class={classMerge("rounded-l-none", s.buttonClass)}
          disabled={s.disabled || (s.max !== undefined && s.valueSignal.get() >= s.max)}
          type={"button"}
        />
      )}
    </div>
  )
}
