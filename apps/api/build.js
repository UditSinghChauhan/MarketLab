/**
 * Bundles the API into one ESM file. Workspace packages (@marketlab/*) ship as
 * TypeScript source, so they are bundled in; third-party dependencies stay
 * external and are installed from package.json at deploy time.
 */
import { readFileSync } from "node:fs";

import { build } from "esbuild";

const pkg = JSON.parse(readFileSync(new URL("package.json", import.meta.url), "utf8"));
const external = Object.keys(pkg.dependencies).filter((name) => !name.startsWith("@marketlab/"));

await build({
  entryPoints: ["src/server.ts"],
  outfile: "dist/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "esm",
  sourcemap: true,
  external,
  logLevel: "info",
});
