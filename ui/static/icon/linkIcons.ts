import { mdiAccountPlus } from "@adaptive-ds/mdi/mdiAccountPlus.js"
import { mdiArrowLeft } from "@adaptive-ds/mdi/mdiArrowLeft.js"
import { mdiArrowRight } from "@adaptive-ds/mdi/mdiArrowRight.js"
import { mdiArrowTopRight } from "@adaptive-ds/mdi/mdiArrowTopRight.js"
import { mdiHome } from "@adaptive-ds/mdi/mdiHome.js"
import { mdiLogin } from "@adaptive-ds/mdi/mdiLogin.js"
import { mdiLoginVariant } from "@adaptive-ds/mdi/mdiLoginVariant.js"
import { mdiLogout } from "@adaptive-ds/mdi/mdiLogout.js"
import { mdiLogoutVariant } from "@adaptive-ds/mdi/mdiLogoutVariant.js"
import { mdiRedoVariant } from "@adaptive-ds/mdi/mdiRedoVariant.js"
import { mdiReload } from "@adaptive-ds/mdi/mdiReload.js"
import { mdiSubdirectoryArrowRight } from "@adaptive-ds/mdi/mdiSubdirectoryArrowRight.js"

export const linkIcons = {
  reload: mdiReload,
  reset: mdiRedoVariant,
  home: mdiHome,
  login: mdiLogin,
  logout: mdiLogout,
  enter: mdiLoginVariant,
  exit: mdiLogoutVariant, // mdiLaunch, mdiExitToApp, mdiExport
  confirm: mdiSubdirectoryArrowRight,
  internalLink: mdiArrowRight,
  externalLink: mdiArrowTopRight,
  back: mdiArrowLeft,
  forward: mdiArrowRight,
  register: mdiAccountPlus,
} as const
