// Builds the hosted simulator for Vercel using the Build Output API:
// one Node function that serves the page and the demo API.
import { build } from "esbuild";
import fs from "node:fs";

const out = ".vercel/output";
const fn = `${out}/functions/index.func`;
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(fn, { recursive: true });

await build({
  entryPoints: ["src/vercel.ts"],
  outfile: `${fn}/index.mjs`,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  // Some dependencies still call require(); give the ESM bundle one.
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
});
fs.copyFileSync("public/simulator.html", `${fn}/simulator.html`);

fs.writeFileSync(
  `${fn}/.vc-config.json`,
  JSON.stringify({ runtime: "nodejs22.x", handler: "index.mjs", launcherType: "Nodejs", shouldAddHelpers: false, supportsResponseStreaming: true, maxDuration: 60 }, null, 2),
);
fs.writeFileSync(`${out}/config.json`, JSON.stringify({ version: 3, routes: [{ src: "/(.*)", dest: "/index" }] }, null, 2));
console.log(`Built ${fn}`);
