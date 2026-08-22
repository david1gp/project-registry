type ProjectAccessLogJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly ProjectAccessLogJsonValue[]
  | { readonly [key: string]: ProjectAccessLogJsonValue }

export type ProjectAccessLogRecord = { readonly [key: string]: ProjectAccessLogJsonValue }
