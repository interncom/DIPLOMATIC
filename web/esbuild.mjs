import * as esbuild from "esbuild";

await esbuild.build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  format: "esm",
  outfile: "dist/index.mjs",
  platform: "browser",
  external: ["react", "@noble/hashes"],
  // minify: true,
  tsconfig: "./tsconfig.json",
});
