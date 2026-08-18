import { For, type JSX } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { DemoNavDataProps } from "#ui/demo_pages/DemoNavDataProps.js"
import { LinkBlock } from "#ui/demo_pages/LinkBlock.jsx"
import { pathDemos } from "#ui/demo_pages/pathDemos.js"
import type { RouteObject } from "#ui/demo_pages/RouteConfig.js"
import type { DemoListType } from "#ui/generate_demo_list/DemoListType.js"
import { LinkButtonExternal } from "#ui/interactive/link/LinkButton.jsx"
import { classesGridCols5xl } from "#ui/static/grid/classesGridCols.js"
import { LayoutWrapperDemo } from "#ui/static/layout/LayoutWrapperDemo.jsx"
import { classArr } from "#ui/utils/classArr.js"
import { objectEntries } from "#utils/obj/objectEntries.js"
import { objectKeys } from "#utils/obj/objectKeys.js"

const log = false

export function generateDemoRoutes(
  demoList: DemoListType,
  prefix = pathDemos,
  Nav: (p: DemoNavDataProps) => JSX.Element,
): RouteObject[] {
  const all = [
    ...getDemosL2(demoList, prefix, Nav),
    ...getDemosL1(demoList, prefix, Nav),
    ...getDemosL0(demoList, prefix, Nav),
    ...getDemos404(demoList, prefix, Nav),
  ]
  if (log)
    console.log(
      "getDemoRoutes",
      all.map((a) => a.path),
    )
  return all
}

function getDemosL2(
  demoList: DemoListType,
  prefix = pathDemos,
  Nav: (p: DemoNavDataProps) => JSX.Element,
): RouteObject[] {
  const op = "getDemosL2"
  return objectEntries(demoList).flatMap(([category, tree]) => {
    return Object.entries(tree).map(([compName, Comp]) => {
      const path = `${prefix}/${category}/${compName}`
      // if (log) console.log(subTree, compName, "->", path)
      if (log) console.log(op, path)
      return {
        path,
        component: () => (
          <LayoutWrapperDemo title={compName}>
            <Dynamic component={Nav} demoList={demoList} category={category} compName={compName} demoPrefix={prefix} />
            <Comp />
          </LayoutWrapperDemo>
        ),
      } satisfies RouteObject
    })
  })
}

function getDemosL1(
  demoList: DemoListType,
  prefix = pathDemos,
  Nav: (p: DemoNavDataProps) => JSX.Element,
): RouteObject[] {
  const op = "getDemosL1"
  return objectEntries(demoList).map(([category, nameComp]) => {
    const path = `${prefix}/${category}`

    const links = objectKeys(nameComp).map((name) => `${prefix}/${category}/${name}`)
    if (log) console.log(op, path)
    if (log) console.log(op, "links:", links)
    const removePrefix = `${prefix}/${category}/`

    return {
      path,
      component: () => (
        <LayoutWrapperDemo title={category}>
          <Dynamic component={Nav} demoList={demoList} category={category} demoPrefix={prefix} />
          <div
            class={classArr(
              "flex flex-col items-center justify-center", // layout
              "bg-gray-50 dark:bg-gray-900", // background
              "p-4", // spacing
            )}
          >
            <div>
              <LinkBlock header={category} removeUrlPrefix={removePrefix} links={links} />
            </div>
          </div>
        </LayoutWrapperDemo>
      ),
    } satisfies RouteObject
  })
}

function getDemosL0(
  demoList: DemoListType,
  prefix: string = pathDemos,
  Nav: (p: DemoNavDataProps) => JSX.Element,
  overridePath?: string,
): RouteObject[] {
  const op = "getDemosL0"
  const path = prefix

  if (log) console.log(op, path)

  return [
    {
      path: overridePath ?? prefix,
      component: () => {
        const categories = objectEntries(demoList)

        return (
          <LayoutWrapperDemo title={"demos"}>
            <Dynamic component={Nav} demoList={demoList} demoPrefix={prefix} />
            <div
              class={classArr(
                "flex flex-col items-center justify-center", // layout
                "bg-gray-50 dark:bg-gray-700", // background
                "p-4", // spacing
              )}
            >
              <div class={classArr(classesGridCols5xl, "gap-4")}>
                <For each={categories}>
                  {([category, tree]) => {
                    const categoryLinks = objectKeys(tree).map((compName) => `${prefix}/${category}/${compName}`)
                    const removePrefix = `${prefix}/${category}/Demo`
                    return (
                      <div>
                        <LinkBlock header={category} removeUrlPrefix={removePrefix} links={categoryLinks} />
                      </div>
                    )
                  }}
                </For>
              </div>
            </div>
          </LayoutWrapperDemo>
        )
      },
    },
  ]
}

function getDemos404(
  demoList: DemoListType,
  prefix = pathDemos,
  Nav: (p: DemoNavDataProps) => JSX.Element,
): RouteObject[] {
  return [
    {
      path: `${prefix}/*`,
      component: () => (
        <LayoutWrapperDemo>
          {/*<SetPageTitle title={"demos"} />*/}
          {/*<DemoPageList />*/}
          <Dynamic component={Nav} demoList={demoList} demoPrefix={prefix} />
          <h1 class={"text-xl font-semibold"}>not found</h1>
          <LinkButtonExternal href={prefix}>back to demos</LinkButtonExternal>
        </LayoutWrapperDemo>
      ),
    },
  ]
}
