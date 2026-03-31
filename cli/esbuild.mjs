import * as esbuild from "esbuild";

const result = await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.mjs",
  platform: "node",
  external: ["@noble/hashes", "libsodium-wrappers"],
  // minify: true,
  tsconfig: "./tsconfig.json",
  metafile: true,
});

console.log(await esbuild.analyzeMetafile(result.metafile));