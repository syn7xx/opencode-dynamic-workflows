import path from "node:path"

import { gui } from "@opencode/plugin/gui/vite"
import { build } from "vite"

const root = path.resolve(import.meta.dir, "..")

await build({
  root,
  configFile: false,
  logLevel: "info",
  plugins: [gui({ entry: "src/gui/bundle.tsx", outFile: "dist/gui-experimental.cjs" })],
})
