import type { SidebarState } from "#ui/interactive/sidebar/SidebarState.jsx"
import { createSignalObject } from "#ui/utils/createSignalObject.js"

export function createSidebarState(
  initialOpenDesktop = true,
  initialOpenMobile = false,
  initialIsMobile = false,
): SidebarState {
  return {
    openDesktop: createSignalObject(initialOpenDesktop),
    openMobile: createSignalObject(initialOpenMobile),
    isMobile: createSignalObject(initialIsMobile),
  }
}
