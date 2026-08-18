import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig } from "vite"
import solid from "vite-plugin-solid"

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "#ui": resolve(import.meta.dirname, "ui"),
    },
  },
  server: {
    port: 3009,
    strictPort: true,
  },
  build: {
    outDir: "dist/ui",
    emptyOutDir: true,
    target: "esnext",
  },
})
