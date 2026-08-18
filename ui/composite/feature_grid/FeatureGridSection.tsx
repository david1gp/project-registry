import { type ComponentProps, splitProps } from "solid-js"
import type { GridFeatureType } from "#ui/static/grid/GridFeatureType.js"
import { Icon } from "#ui/static/icon/Icon.jsx"
import { classArr } from "#ui/utils/classArr.js"
import { classMerge } from "#ui/utils/classMerge.js"

export interface FeatureGridSectionProps extends ComponentProps<"section"> {
  id: string
  title: string
  titleClass?: string
  subtitle1: string
  subtitle1Class?: string
  subtitle2?: string
  subtitle2Class?: string
  features: GridFeatureType[]
  headerClass?: string
  gridClass?: string
  cardClass?: string
}

/** Section displaying features in a responsive icon grid. */
export function FeatureGridSection(p: FeatureGridSectionProps) {
  const [s, rest] = splitProps(p, [
    "id",
    "title",
    "titleClass",
    "subtitle1",
    "subtitle1Class",
    "subtitle2",
    "subtitle2Class",
    "features",
    "headerClass",
    "gridClass",
    "cardClass",
    "class",
  ])
  return (
    <section id={s.id} class={classMerge("w-full", "py-25 px-4", s.class)} {...rest}>
      <div class={classArr("max-w-7xl mx-auto", "text-center mb-8", s.headerClass)}>
        <h2 class={classArr("text-3xl sm:text-4xl font-bold", "mb-4", "group flex items-center justify-center")}>
          <span>{s.title}</span>
          <a
            href={"#" + s.id}
            class="opacity-0 group-hover:opacity-100 p-1 rounded hidden sm:flex"
            title="Link to this section"
          >
            <Icon
              path="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1"
              class="size-6 fill-gray-500 dark:fill-gray-500"
            />
          </a>
        </h2>
        <p class={classMerge("text-xl text-muted-foreground mx-auto", s.subtitle1Class)}>{s.subtitle1}</p>
        {s.subtitle2 && (
          <p class={classMerge("text-xl text-muted-foreground mx-auto mt-1", s.subtitle2Class)}>{s.subtitle2}</p>
        )}
      </div>

      <div class={classMerge("grid md:grid-cols-2 lg:grid-cols-3 gap-8", "max-w-7xl mx-auto", s.gridClass)}>
        {s.features.map((feature) => (
          <div class={classMerge("bg-white dark:bg-gray-800", "rounded-lg p-6", "shadow-md lg:shadow-lg", s.cardClass)}>
            <div class="flex items-center gap-3 mb-4">
              <Icon path={feature.icon} class="size-8" />
              <h3 class="text-xl font-semibold">{feature.title}</h3>
            </div>
            <p class="text-muted-foreground">{feature.description}</p>
          </div>
        ))}
      </div>
    </section>
  )
}
