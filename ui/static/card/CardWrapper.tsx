import { type ComponentProps, splitProps } from "solid-js"
import { classesCardWrapperP4 } from "#ui/static/card/classesCardWrapper.js"
import { classMerge } from "#ui/utils/classMerge.js"

export interface CardWrapperProps extends ComponentProps<"article"> {
  id?: string
}

/** Styled card container wrapping article content. */
export function CardWrapper(p: CardWrapperProps) {
  const [s, rest] = splitProps(p, ["id", "class"])
  return <article id={s.id} class={classMerge(classesCardWrapperP4, s.class)} {...rest} />
}
