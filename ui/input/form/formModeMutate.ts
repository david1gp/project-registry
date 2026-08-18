export type FormModeMutate = keyof typeof formModeMutate

export const formModeMutate = {
  edit: "edit",
  remove: "remove",
} as const

export interface HasFormModeMutate {
  mode: FormModeMutate
}
