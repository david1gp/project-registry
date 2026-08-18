import { Route, Router } from "@solidjs/router"
import type { JSX } from "solid-js"
import { HelloWorldPage } from "./HelloWorldPage.js"

export function ProjectRegistryApp(): JSX.Element {
  return (
    <Router>
      <Route path="/" component={HelloWorldPage} />
    </Router>
  )
}
