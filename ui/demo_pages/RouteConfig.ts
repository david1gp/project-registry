import type { Component, JSXElement } from "solid-js"

export type RouteObject = {
  path: string
  component: Component<any> | (() => JSXElement)
}

export type RouteConfig = RouteObject[]
