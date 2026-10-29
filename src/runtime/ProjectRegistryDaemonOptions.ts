import type { PromiseResult } from "#result"
import type { ProjectAccessLogSource } from "../access-log/ProjectAccessLogSource.js"
import type { CaddyApplication } from "../caddy/CaddyApplication.js"
import type { CaddyFetch } from "../caddy/CaddyFetch.js"
import type { CaddyProcessRunner } from "../caddy/CaddyProcessRunner.js"
import type { CaddyTimer } from "../caddy/CaddyTimer.js"
import type { CloudflareDnsFetch } from "../cloudflare/CloudflareDnsFetch.js"
import type { ProjectPrivateTlsGateSnapshot } from "../project/projectPrivateTlsGate.js"
import type { ProjectRepository } from "../project-store/ProjectRepository.js"
import type { SessionStore } from "../session/SessionStore.js"
import type { TokenReferenceStore } from "../session/TokenReferenceStore.js"
import type { TailscaleSplitDnsFetch } from "../tailscale/TailscaleSplitDnsFetch.js"
import type { ZitadelHttp } from "../zitadel/ZitadelHttp.js"
import type { ProjectRegistryDaemonBrowserAuth } from "./ProjectRegistryDaemonBrowserAuth.js"
import type { ProjectRegistryDaemonCloudflareCredentialsFilesystem } from "./ProjectRegistryDaemonCloudflareCredentialsFilesystem.js"
import type { ProjectRegistryDaemonCloudflareDnsTrackingFilesystem } from "./ProjectRegistryDaemonCloudflareDnsTrackingFilesystem.js"
import type { ProjectRegistryDaemonFilesystem } from "./ProjectRegistryDaemonFilesystem.js"
import type { ProjectRegistryDaemonMappedUsersResolve } from "./ProjectRegistryDaemonMappedUsersResolve.js"
import type { ProjectRegistryDaemonPosix } from "./ProjectRegistryDaemonPosix.js"
import type { ProjectRegistryDaemonPrivateDnsTrackingFilesystem } from "./ProjectRegistryDaemonPrivateDnsTrackingFilesystem.js"
import type { ProjectRegistryDaemonRequestHandler } from "./ProjectRegistryDaemonRequestHandler.js"
import type { ProjectRegistryDaemonServerFactory } from "./ProjectRegistryDaemonServerFactory.js"
import type { ProjectRegistryDaemonServerIpFilesystem } from "./ProjectRegistryDaemonServerIpFilesystem.js"
import type { ProjectRegistryDaemonServerIpLogger } from "./ProjectRegistryDaemonServerIpLogger.js"
import type { ProjectRegistryDaemonSignals } from "./ProjectRegistryDaemonSignals.js"
import type { ProjectRegistryDaemonSocketAccessResolve } from "./ProjectRegistryDaemonSocketAccessResolve.js"
import type { ProjectRegistryDaemonWikiReconcile } from "./ProjectRegistryDaemonWikiReconcile.js"

export type ProjectRegistryDaemonOptions = {
  config: unknown
  repository?: ProjectRepository
  caddyApplication?: CaddyApplication
  projectAccessLogSource?: ProjectAccessLogSource
  browserAuth?: ProjectRegistryDaemonBrowserAuth
  socketAccessResolve?: ProjectRegistryDaemonSocketAccessResolve
  sessions?: SessionStore
  tokenReferences?: TokenReferenceStore
  zitadelHttp?: ZitadelHttp
  mappedUsersResolve?: ProjectRegistryDaemonMappedUsersResolve
  requestHandler?: ProjectRegistryDaemonRequestHandler
  filesystem?: ProjectRegistryDaemonFilesystem
  posix?: ProjectRegistryDaemonPosix
  serverFactory?: ProjectRegistryDaemonServerFactory
  signals?: ProjectRegistryDaemonSignals
  timer?: CaddyTimer
  caddyProcessRunner?: CaddyProcessRunner
  caddyFetch?: CaddyFetch
  serverIpFilesystem?: ProjectRegistryDaemonServerIpFilesystem
  serverIpFetch?: CaddyFetch
  serverIpLogger?: ProjectRegistryDaemonServerIpLogger
  serverIpClock?: () => number
  cloudflareDnsFetch?: CloudflareDnsFetch
  cloudflareDnsTrackingFilesystem?: ProjectRegistryDaemonCloudflareDnsTrackingFilesystem
  cloudflareDnsCredentialsFilesystem?: ProjectRegistryDaemonCloudflareCredentialsFilesystem
  privateDnsFetch?: TailscaleSplitDnsFetch
  privateDnsTrackingFilesystem?: ProjectRegistryDaemonPrivateDnsTrackingFilesystem
  privateDnsCredentialsFilesystem?: ProjectRegistryDaemonCloudflareCredentialsFilesystem
  privateDnsResolverReload?: () => PromiseResult<void>
  privateTlsTrustedProbe?: (hostname: string) => PromiseResult<"trusted">
  privateTlsGateState?: { update(snapshot: ProjectPrivateTlsGateSnapshot): void }
  wikiReconcile?: ProjectRegistryDaemonWikiReconcile
  requireRoot?: boolean
}
