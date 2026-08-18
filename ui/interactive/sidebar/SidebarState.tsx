import type { SignalObject } from "#ui/utils/createSignalObject.js"

export interface SidebarState {
  openDesktop: SignalObject<boolean>
  openMobile: SignalObject<boolean>
  isMobile: SignalObject<boolean>
}
