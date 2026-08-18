import type { DemoListType } from "#ui/generate_demo_list/DemoListType.js"

export interface DemoNavDataProps {
  category?: string
  compName?: string
  demoList: DemoListType
  demoPrefix: string
}
