import { render } from "solid-js/web"
import { ProjectRegistryApp } from "./app/ProjectRegistryApp.js"
import "./styles.css"

const rootElement = document.getElementById("root")

if (!rootElement) {
  throw new Error("Root element #root was not found")
}

render(() => <ProjectRegistryApp />, rootElement)
