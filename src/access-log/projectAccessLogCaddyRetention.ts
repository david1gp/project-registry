export const projectAccessLogCaddyRetention = {
  rollSizeMb: 25,
  rollKeep: 1,
  rollKeepDays: 14,
  maximumProjectBytes: 50 * 1024 * 1024,
} as const
