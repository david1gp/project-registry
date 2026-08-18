import type { ComponentProps, ParentComponent } from "solid-js"
import { type Component, type JSXElement, mergeProps, Show, splitProps } from "solid-js"
import { classMerge } from "#ui/utils/classMerge.js"

export interface TimelinePropsItem
  extends Omit<TimelineItemProps, "isActive" | "isActiveBullet" | "bulletSize" | "lineSize"> {
  bulletSize?: number
}

export type TimelineProps = {
  items: TimelinePropsItem[]
  activeItem: number
  bulletSize?: number
  lineSize?: number
}

/*
  No bullet or line is active when activeItem is -1
  First bullet is active only if activeItem is 0 or more
  First line is active only if activeItem is 1 or more
*/

const Timeline: Component<TimelineProps> = (rawProps) => {
  const p = mergeProps({ bulletSize: 16, lineSize: 2 }, rawProps)

  return (
    <ul
      style={{
        "padding-left": `${p.bulletSize / 2}px`,
      }}
    >
      {p.items.map((item, index) => {
        return (
          <TimelineItem
            title={item.title}
            description={item.description}
            bullet={item.bullet}
            isLast={index === p.items.length - 1}
            isActive={p.activeItem === -1 ? false : p.activeItem >= index + 1}
            isActiveBullet={p.activeItem === -1 ? false : p.activeItem >= index}
            bulletSize={p.bulletSize}
            lineSize={p.lineSize}
          />
        )
      })}
    </ul>
  )
}

export type TimelineItemProps = {
  title: JSXElement
  description?: JSXElement
  bullet?: JSXElement
  isLast?: boolean
  isActive: boolean
  isActiveBullet: boolean
  class?: string
  bulletSize: number
  lineSize: number
}

const TimelineItem: Component<TimelineItemProps> = (p) => {
  const [s, rest] = splitProps(p, [
    "class",
    "bullet",
    "description",
    "title",
    "isLast",
    "isActive",
    "isActiveBullet",
    "bulletSize",
    "lineSize",
  ])
  return (
    <li
      class={classMerge(
        "relative border-l pb-8 pl-8",
        s.isLast && "border-l-transparent pb-0",
        s.isActive && !s.isLast && "border-l-primary",
        s.class,
      )}
      style={{
        "border-left-width": `${s.lineSize}px`,
      }}
      {...rest}
    >
      <TimelineItemBullet lineSize={s.lineSize} bulletSize={s.bulletSize} isActive={s.isActiveBullet}>
        {s.bullet}
      </TimelineItemBullet>
      <TimelineItemTitle>{s.title}</TimelineItemTitle>
      <Show when={s.description}>
        <TimelineItemDescription>{s.description}</TimelineItemDescription>
      </Show>
    </li>
  )
}

export type TimelineItemBulletProps = {
  children?: JSXElement
  isActive?: boolean
  bulletSize: number
  lineSize: number
}

const TimelineItemBullet: Component<TimelineItemBulletProps> = (p) => {
  return (
    <div
      class={classMerge(
        `absolute top-0 flex items-center justify-center rounded-full border`,
        p.isActive && "border-primary",
      )}
      style={{
        width: `${p.bulletSize}px`,
        height: `${p.bulletSize}px`,
        left: `${-p.bulletSize / 2 - p.lineSize / 2}px`,
        "border-width": `${p.lineSize}px`,
      }}
      aria-hidden="true"
    >
      {p.children}
    </div>
  )
}

const TimelineItemTitle: ParentComponent = (p) => {
  return <div class={"mb-1 text-base font-semibold leading-none"}>{p.children}</div>
}

const TimelineItemDescription: Component<ComponentProps<"p">> = (p) => {
  const [s, rest] = splitProps(p, ["class", "children"])
  return (
    <p class={classMerge("text-muted-foreground text-sm", s.class)} {...rest}>
      {s.children}
    </p>
  )
}

export { Timeline }
