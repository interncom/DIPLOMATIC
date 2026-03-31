import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.mjs",
  outdir: "dist",
  platform: "node",
  external: ["@noble/hashes", "libsodium-wrappers"],
  // minify: true,
  tsconfig: "./tsconfig.json",
  dts: true,
  metafile: true,
});

console.log(await esbuild.analyzeMetafile(result.metafile));