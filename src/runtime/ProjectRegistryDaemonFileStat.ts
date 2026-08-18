export type ProjectRegistryDaemonFileStat = {
  type: "directory" | "file" | "socket" | "symlink" | "other"
  mode: number
  uid: number
  gid: number
}
