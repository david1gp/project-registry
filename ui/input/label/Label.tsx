import type { Component, ComponentProps } from "solid-js"
import { splitProps } from "solid-js"
import { classesLabel } from "#ui/input/label/classesLabel.js"
import { classMerge } from "#ui/utils/classMerge.js"

/** Styled native label element for form fields. */
export const Label: Component<ComponentProps<"label">> = (p) => {
  const [s, rest] = splitProps(p, ["class"])
  return <label class={classMerge(classesLabel, s.class)} {...rest} />
}
