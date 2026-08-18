import { resolve } from "node:path"
import { defineConfig } from "@rsbuild/core"
import { pluginBabel } from "@rsbuild/plugin-babel"
import { pluginSolid } from "@rsbuild/plugin-solid"
import { pluginTailwindcss } from "@rsbuild/plugin-tailwindcss"

export default defineConfig({
  server: {
    port: 3009,
    strictPort: true,
  },
  html: {
    template: "./rsbuild.html",
  },
  source: {
    entry: {
      index: "./src/ui/main.tsx",
    },
    alias: {
      "#ui": resolve(import.meta.dirname, "ui"),
    },
  },
  plugins: [
    pluginBabel({
      include: /\.(?:jsx|tsx)$/,
    }),
    pluginSolid(),
    pluginTailwindcss(),
  ],
  output: {
    distPath: {
      root: "dist/ui",
      html: "",
      js: "assets",
      css: "assets",
      assets: "assets",
      media: "assets",
    },
    target: "web",
  },
})
