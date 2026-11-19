/**
 * How long Caddy keeps upgraded (WebSocket) proxy streams open after a config
 * load replaced their handler. Caddy's default (0) closes every WebSocket on
 * each `/load` with code 1001, and the daemon loads a new config on every
 * dev lease/service change (dozens per hour on a shared server). Convex
 * clients then fail every in-flight action ("Connection lost while action was
 * in flight") and resubscribe everything. Delay the close instead; streams
 * still end when either side closes them.
 */
export const caddyProxyStreamCloseDelay = "10m"
