import type { ProjectRepositoryServiceGrouping } from "./ProjectRepositoryServiceGrouping.js"

export const projectRepositoryLeoServiceGroupings: readonly ProjectRepositoryServiceGrouping[] = [
  {
    source: { owner: "leo", name: "emailoutreach-prod" },
    parent: { owner: "leo", name: "emailoutreach" },
    serviceId: "emailoutreach-prod",
  },
  {
    source: { owner: "leo", name: "allgroups-chat-ui" },
    parent: { owner: "leo", name: "allgroups-chat" },
    serviceId: "allgroups-chat-ui",
  },
  {
    source: { owner: "leo", name: "allgroups-chat-convex" },
    parent: { owner: "leo", name: "allgroups-chat" },
    serviceId: "allgroups-chat-convex",
  },
  {
    source: { owner: "leo", name: "allgroups-chat-api" },
    parent: { owner: "leo", name: "allgroups-chat" },
    serviceId: "allgroups-chat-api",
  },
  {
    source: { owner: "leo", name: "allgroups-chat-dash" },
    parent: { owner: "leo", name: "allgroups-chat" },
    serviceId: "allgroups-chat-dash",
  },
  {
    source: { owner: "leo", name: "sales-api" },
    parent: { owner: "leo", name: "sales" },
    serviceId: "sales-api",
  },
  {
    source: { owner: "leo", name: "sales-web-preview" },
    parent: { owner: "leo", name: "sales" },
    serviceId: "sales-web-preview",
  },
  {
    source: { owner: "leo", name: "sales-web-prod" },
    parent: { owner: "leo", name: "sales" },
    serviceId: "sales-web-prod",
  },
]
