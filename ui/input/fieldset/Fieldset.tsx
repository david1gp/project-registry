import type { Component, JSXElement } from "solid-js"
import { splitProps } from "solid-js"
import { classMerge } from "#ui/utils/classMerge.js"
import type { MayHaveChildren } from "#ui/utils/MayHaveChildren.js"
import type { MayHaveSubtitle } from "#ui/utils/MayHaveSubtitle.js"
import type { MayHaveTitle } from "#ui/utils/MayHaveTitle.js"
import { classesFieldset } from "./classesFieldset.js"

export interface FieldsetProps extends MayHaveChildren, MayHaveTitle, MayHaveSubtitle {
  class?: string
  titleChildren?: JSXElement
}

/** Fieldset grouping inputs under a titled legend. */
export const Fieldset: Component<FieldsetProps> = (p) => {
  const [s, rest] = splitProps(p, ["children", "title", "titleClass", "titleChildren", "subtitleClass", "class"])

  return (
    <fieldset class={classMerge(classesFieldset, s.class)} {...rest}>
      <legend class={classMerge("px-1", s.titleClass)}>{s.titleChildren ?? s.title}</legend>
      {s.children}
    </fieldset>
  )
}
