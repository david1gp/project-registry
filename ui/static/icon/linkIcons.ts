import {
  mdiAccountPlus,
  mdiArrowLeft,
  mdiArrowRight,
  mdiArrowTopRight,
  mdiHome,
  mdiLogin,
  mdiLoginVariant,
  mdiLogout,
  mdiLogoutVariant,
  mdiRedoVariant,
  mdiReload,
  mdiSubdirectoryArrowRight,
} from "@mdi/js"

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
