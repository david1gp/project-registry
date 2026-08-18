export type EnvMode = keyof typeof envMode

export const envMode = {
  development: "development",
  production: "production",
  test: "test",
  missing: "missing",
} as const
