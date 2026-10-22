import { rm } from "node:fs/promises"
import path from "node:path"

const directory = path.resolve(process.argv[2] ?? ".")
await rm(path.join(directory, "dist"), { recursive: true, force: true })
const result = await Bun.build({
  entrypoints: [path.join(directory, "src/index.ts")],
  outdir: path.join(directory, "dist"),
  target: "bun",
  format: "esm",
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
